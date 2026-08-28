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
// ══ `tMax` IS A DISTANCE, NOT A BRICK COUNT (Stage 3.2) ═════════════════════
//
// ⭐⭐ THE BUG THAT MADE EVERY FRESH SHADE BLACK. The brick loop tests
// `t >= tMax` at its top, and `t` is the time the ray ENTERS a brick — so a
// query whose limit falls inside a brick still walks that brick's voxels to
// its far side and can report a hit up to A WHOLE BRICK (1 m at L0, 16 m at
// L4) beyond the distance it was asked about.
//
// Every shadow ray toward an area light ends just short of that light, which
// means it ends INSIDE the light's own brick. So every panel NEE ray in
// `gatherProbes.shadeHit` walked on and hit the panel, `vis` came back 0, and
// the fresh-slot shade — §L.2's ONLY source of light for surfaces the screen
// cannot inject — wrote BLACK. Every time, on every surface, since Stage 3.1.
//
// It was invisible to every receipt the gather had: the Cornell crops all sit
// on VISIBLE surfaces, whose cache entries `injectLitFrame` overwrites with
// the real lit colour, so the crops measured the injection and never the
// shade. It took reading the cache at the one surface in a Cornell box that
// no pixel ever covers — the wall behind the camera — to see a written zero,
// and then running the whole chain with the injection pass switched off to
// see that the zero was universal (0 of 10 named surfaces carried light after
// 38 141 fresh shades).
//
// The fix is one compare in the voxel loop: a voxel ENTERED at or after
// `tMax` cannot block, and the loop stops there.
//
// ══ A RAY MAY NOT BEGIN INSIDE GEOMETRY (Stage 3.2 item 2) ══════════════════
//
// K.4's origin bias — half a level-0 cell along the geometric normal — exists
// because a screen probe's anchor sits ON a surface, inside that surface's own
// voxel. Half a cell clears a voxel the surface merely PASSES THROUGH. It
// clears nothing at all on a surface the voxelizer had to DILATE, and
// conservative triangle/voxel overlap dilates everything: the occupied set is
// the surface grown by up to a cell diagonal. Measured on the harness's 1 m
// sphere (centre 0.5 m radius, v0 = 0.25): a cell is marked whenever it
// INTERSECTS the ball, so the occupied region reaches 0.75 m from the centre
// and the biased origin at 0.625 m is inside it FOR EVERY NORMAL — not just
// the oblique ones the first reading blamed. `probe:gi2-gather`'s probe audit
// measured the consequence directly: 70–75 % of that sphere's probe rays
// returned a hit at t < 6 cm. A probe reading its own darkness back, 3 rays in
// 4. That is the black crescent.
//
// Two separate things follow, and conflating them is what made the first fix
// attempt wrong:
//
//   1. THE BIAS IS A CALLER PARAMETER, in cells of `v_l` — the cell size of
//      the level the origin sits on, not v0. A ray that starts outside the
//      finest window starts in a coarser cell and needs a coarser bias.
//
//   2. THE ORIGIN ESCAPES. If the biased origin's own voxel is still
//      occupied, push another WHOLE CELL along the normal, up to
//      `ORIGIN_ESCAPE` times. This is not a bias that got bigger: it fires
//      only where the voxelization is thicker than the surface, costs one
//      occupancy read on the common path (free cell, loop breaks at once),
//      and cannot move a ray that has no normal to move along.
//
// And for the origins the escape cannot save (a ray genuinely born inside a
// solid — the leak test fires 1.4 % of its rays from inside the box), the
// voxel containing the origin is tested by the face the ray LEAVES through
// rather than by a seeded entry face:
//
//     a ray starting inside an occupied voxel ignores that voxel's ENTRY
//     face and honours its EXIT face.
//
// Leaving a wall's voxel through the wall's own face still blocks — a ray
// born inside a 5 cm wall ⊥ X and travelling +X leaves through the +X face,
// whose bit that wall sets, so it is stopped. A ray born in the same voxel and
// travelling +Z leaves through the +Z face, which a wall ⊥ X does not set, and
// is correctly let through: it runs PARALLEL to the wall inside the wall's
// cell, which is the thickening the face bits exist to remove. The seeded
// "dominant axis" entry face this replaces was an invention — the ray made no
// step to arrive where it was born, so there is no entry face to read, and
// picking one fails closed on exactly the rays that are not blocked.
//
// ══ §AG — A THIN VOXEL DOES NOT STOP A RAY, IT DIMS IT ══════════════════════
//
// ⭐⭐ Occupancy is one bit, so until this stage a 2 cm cable and a 20 cm wall
// were the SAME OBJECT to this loop. On Bistro the string-light cables
// voxelized into a continuous slab across the whole street and the balcony
// ironwork into black walls; everything below lost most of its sky, and the
// indirect went flat and the bounce black. `windowStore.js`'s COVERAGE block
// has the diagnosis and the four classes.
//
// The rule here is one branch: a voxel of class < 3 that the entry-face test
// would have stopped the ray at instead multiplies the ray's THROUGHPUT by
// `1 − COV_ATTEN[class]` and the DDA CONTINUES. The hit that is reported is the
// first class-3 voxel; the throughput is returned beside it, so the caller can
// weight that hit's radiance by `T` and credit `1 − T` to what the thin voxels
// were.
//
//   · DETERMINISTIC (§T). No stochastic termination, no dither, no frame index
//     — `T` is a product of per-class constants over the voxels the ray met, so
//     two identical rays in two frames return the identical number.
//   · THE WALL INVARIANT IS UNTOUCHED. A surface is class 3 and class 3 breaks
//     the loop exactly as an occupied voxel always did; the §V.1 gate's 5 cm
//     wall is class 3 at every level.
//   · ONE EXTRA BUFFER READ, and only on the path that was already reading the
//     face byte — i.e. only inside a voxel that is occupied AND blocks. The
//     DYNAMIC layer is not read at all: a mover is solid by decree, so an
//     `occDyn` hit is class 3 without a fetch.
//
// ══ RETURN SHAPE ════════════════════════════════════════════════════════════
//
// A laid-out WGSL function cannot return a struct (occupancyField's traceBody
// learned this), so the shared fn returns `vec4(hit, t, packed, steps)` and the
// JS wrapper unpacks. `packed = faceId | level << 3 | voxelIdx << 6` reaches
// 16777213 at its maximum — exactly one below 2^24, so every value round-trips
// through f32 EXACTLY. That is a checked property, not a lucky fit: faceId is
// 3 bits, level 3, and a 64³ voxel index 18.
//
// ⭐ AND THAT IS WHY THE THROUGHPUT RIDES IN `w`'s FRACTION. `packed` has no
// spare bit (all 24 are spoken for), `hit` is compared against 0.5 by every
// caller and `t` is a distance — so the one component with room is the STEP
// COUNT, whose integer part is all anyone ever wanted from it. `w = used +
// round(T·255)/256` keeps `floor(w)` exactly the old step count for the two
// receipts in `gatherProbes` that read `raw.w` directly, and hands the wrapper
// eight bits of throughput for free. Exact in f32: `used < 2^15` and the
// fraction is a multiple of 1/256, so 23 bits of mantissa cover both.
import {
  Break, If, Loop, bitAnd, bitOr, dot, exp2, float, int, select, shiftLeft, shiftRight, uint, vec3,
  vec4,
} from "three/tsl";
import { sharedFn } from "../giFn.js";
import {
  BMASK_OFF, BRICK, BRICKS, COV_ATTEN, COV_OFF, COV_OPAQUE, FACE_OFF, LEVEL_WORDS, N, OCC_OFF,
} from "./windowStore.js";

/**
 * The throughput at which a ray gives up and reports a hit.
 *
 * A BACKSTOP, not a tuning knob: without it a ray grazing along a cable could
 * cross fifty class-0 voxels and still report "nothing there", and a dense
 * canopy would never cast a shadow at all. 0.05 is 3 class-2 voxels, 11
 * class-1 voxels or 49 class-0 ones — one lattice, one hedge, or a cable the
 * ray is travelling ALONG rather than across.
 *
 * It also bounds nothing about cost: the brick step budget already does that,
 * and a ray that never stops costs exactly what a MISS has always cost.
 */
export const THROUGHPUT_MIN = 0.05;

/**
 * How many whole cells the origin may walk along its normal to get out of an
 * occupied voxel. Two clears the harness's sphere at every normal; three is
 * the budget, and a ray that has not escaped by then is inside something and
 * falls back on the exit-face rule.
 */
export const ORIGIN_ESCAPE = 3;

/** The default origin bias, in cells of the level the origin sits on. */
export const DEFAULT_BIAS_CELLS = 0.5;

/** Face bit order: 0 = +X, 1 = −X, 2 = +Y, 3 = −Y, 4 = +Z, 5 = −Z. */
export const FACE_BIT = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 };

/**
 * ⭐⭐ §19 STAGE 3.9 — THE FACE BYTE'S SPARE BITS CARRY THE **DOMINANT NORMAL**.
 *
 * Bits 0-5 answer "can a ray travelling this way be stopped here?" — BLOCKING,
 * and they stay permissive (Stage 3.8 measured 95 % of Bistro's façade voxels
 * carrying all six, because `|n.a| > 1e-3` sets a pair for any wall that is not
 * perfectly axis-aligned, and the 0/10 000 leak receipt depends on exactly
 * that).
 *
 * Bits 6-7 answer a DIFFERENT question — "which of the six cache slots IS this
 * voxel's surface?" — and 3.8's dirt is what happens when the first answer is
 * used for the second: a grazing ray files its hit under the ±Y it happened to
 * enter through, `faceSamplePoint` puts that slot's shade point inside the wall
 * column, and `ORIGIN_ESCAPE` walks it out into open sun at 78-87× the wall's
 * true radiance.
 *
 * ⚠ 0 MEANS "NOT KNOWN", NOT "X". Three producers write the face byte — the
 * static voxelizer, the analytic fill and `windowDynamic` — and only the first
 * two can compute an area-weighted argmax. A zero therefore has to be the SAFE
 * value (fall back on the entry face, i.e. Stage 3.8's behaviour) rather than a
 * legal axis, or every dynamic voxel in the world would claim to be an X wall.
 *
 * ⚠ NOTHING READ BITS 6-7 BEFORE THIS STAGE, so there was no two-sided or
 * dyn-mirror flag to relocate. Grepped at 3eda2a7: `FACE_OFF` has five readers
 * (`windowTrace` here, `windowFill`, `windowVoxelize`, `windowDynamic`, and the
 * probes' CPU-side readbacks) and every one of them masks the byte with 255 and
 * then tests one of bits 0-5 — the two-sidedness the §K.4 sketch imagined
 * putting there is expressed by the PAIR rule (both bits of an axis go
 * together) and the dynamic layer is a separate level slot, not a flag.
 */
export const FACE_AX_SHIFT = 6;
export const FACE_AX_MASK = 0b11000000;
export const FACE_AX_NONE = 0;
/** Axis 0/1/2 → the 2-bit code stored in bits 6-7. */
export const packFaceAxis = (a) => (a + 1) << FACE_AX_SHIFT;
/** The stored byte → axis 0/1/2, or −1 for "not known". */
export const unpackFaceAxis = (byte) => (((byte >>> FACE_AX_SHIFT) & 3) - 1);

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
      { name: "biasCells", type: "float" },
    ],
    body: (ro, rd, rn, tMax, biasCells) => {
      const n0 = vec3(rn).toVar();
      const d = vec3(rd).toVar();
      // A zero normal means "no bias, no escape" — the leak test's rays are
      // born in mid-air and have no surface to be pushed off.
      const hasN = dot(n0, n0).greaterThan(0.25).toVar();
      // The level of the UNBIASED origin. The bias is measured in THAT level's
      // cells, so it has to be found before the bias is applied; the biased
      // origin's own level is found again below, because the escape can walk
      // the origin out of one window and into another.
      const lvl0 = int(levels - 1).toVar();
      for (let l = levels - 1; l >= 0; l--) {
        const rel0 = vec3(ro).div(float(voxel0 * Math.pow(2, l))).floor().sub(vec3(originsU[l]));
        const in0 = rel0.x.greaterThanEqual(0).and(rel0.y.greaterThanEqual(0)).and(rel0.z.greaterThanEqual(0))
          .and(rel0.x.lessThan(N)).and(rel0.y.lessThan(N)).and(rel0.z.lessThan(N));
        lvl0.assign(select(in0, int(l), lvl0));
      }
      const vl0 = float(voxel0).mul(exp2(lvl0.toFloat())).toVar();
      const o = vec3(ro).add(n0.mul(vl0.mul(biasCells))).toVar();

      // THE ESCAPE. See the header. The addressing is hoisted OUT of the loop:
      // level, cell size, window origin and slot base cannot change while the
      // origin walks a fraction of a cell, and recomputing the level's select
      // chain three times per ray was measurable (probeTrace 0.34 → 0.48 ms
      // when the naive form shipped). One occupancy read on the common path,
      // because the first test finds a free cell and breaks.
      const org0 = originAt(lvl0).toVar();
      const slot0 = lvl0.toUint().mul(uint(LEVEL_WORDS)).add(uint(OCC_OFF)).toVar();
      const dyn0 = useDynamic
        ? uint(levels).add(lvl0.min(int(dynLevels - 1)).toUint()).mul(uint(LEVEL_WORDS)).add(uint(OCC_OFF)).toVar()
        : null;
      const useDyn0 = useDynamic ? lvl0.lessThan(int(dynLevels)) : null;
      Loop({ start: 0, end: ORIGIN_ESCAPE, name: "gi2Escape" }, () => {
        const c = o.div(vl0).floor().toVar();
        const rel = c.sub(org0).toVar();
        // A point outside the level's window reads as FREE: the escape must
        // not push a ray that has simply left the window.
        const inside = rel.x.greaterThanEqual(0).and(rel.y.greaterThanEqual(0)).and(rel.z.greaterThanEqual(0))
          .and(rel.x.lessThan(N)).and(rel.y.lessThan(N)).and(rel.z.lessThan(N));
        const vi = bitOr(bitOr(
          bitAnd(c.x.toInt(), int(N - 1)).toUint(),
          shiftLeft(bitAnd(c.y.toInt(), int(N - 1)).toUint(), uint(6))),
        shiftLeft(bitAnd(c.z.toInt(), int(N - 1)).toUint(), uint(12))).toVar();
        const bit = shiftLeft(uint(1), bitAnd(vi, uint(31))).toVar();
        const word = shiftRight(vi, uint(5)).toVar();
        // Never an `If()` around a buffer read — the idiom that rendered the
        // BVH mirror pass black. The INDEX is in range, the VALUE is gated.
        const st = bitAnd(buffer.element(slot0.add(word)), bit).toVar();
        const dy = useDynamic
          ? select(useDyn0, bitAnd(buffer.element(dyn0.add(word)), bit), uint(0)).toVar()
          : uint(0);
        const blocked = hasN.and(inside).and(bitOr(st, dy).notEqual(uint(0))).toVar();
        If(blocked, () => { o.addAssign(n0.mul(vl0)); }).Else(() => { Break(); });
      });
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
      // §AG. 1 = nothing dimmed this ray yet. Every class < 3 voxel it is
      // stopped by multiplies it; the caller weights the hit by it.
      const thru = float(1).toVar();
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
      // "This is still the voxel the ray was born in." Cleared after the first
      // voxel of the first brick, and again at the end of the first brick, so
      // an empty starting brick cannot hand the flag to the next one.
      const firstVox = float(1).toVar();

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

              // WHEN this voxel ends, and by which axis — computed BEFORE the
              // face test, because the origin voxel is tested against the face
              // the ray LEAVES by and that axis is not known until now.
              const tv = vec3(
                vcell.x.add(stepPos.x).mul(vl).sub(o.x).mul(inv.x),
                vcell.y.add(stepPos.y).mul(vl).sub(o.y).mul(inv.y),
                vcell.z.add(stepPos.z).mul(vl).sub(o.z).mul(inv.z),
              ).toVar();
              const tV = tv.x.min(tv.y).min(tv.z).toVar();
              const axisV = select(tV.equal(tv.x), float(0), select(tV.equal(tv.y), float(1), float(2))).toVar();
              const atOrigin = firstVox.greaterThan(0.5).toVar();
              firstVox.assign(0);
              // The distance this voxel would report a hit AT: where the ray
              // entered it, or — for the voxel the ray was born in, which it
              // can only be blocked by on the way OUT — where it leaves.
              const tHit = select(atOrigin, tV, tv0).toVar();
              // ⭐ `tMax` IS A DISTANCE. See the header: the brick loop's test
              // is at brick granularity, so without this a bounded query walks
              // on to the far side of the brick its limit fell inside.
              If(tv0.greaterThanEqual(tMax), () => { Break(); });

              If(bitOr(occStatic, occDyn).notEqual(uint(0)).and(tHit.lessThan(tMax)), () => {
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
                // ⭐⭐ §AG — THE VOXEL'S COVERAGE CLASS, read HERE and not
                // inside the face-bit branch below on purpose. `fStatic` above
                // is the existing proof that a buffer read at THIS nesting is
                // safe; one level deeper is a conditional read, which is the
                // idiom that rendered the BVH mirror pass black, and the saving
                // would be a fetch on voxels whose face test fails — 5 % of
                // Bistro's façade voxels, since 95 % of them carry all six bits.
                //
                // ⚠ THE DYNAMIC LAYER IS NOT READ. A mover is solid by decree,
                // so `occDyn` forces class 3 without a second fetch.
                const covRaw = bitAnd(
                  shiftRight(
                    buffer.element(slotBase.add(uint(COV_OFF)).add(shiftRight(vi, uint(4)))),
                    bitAnd(vi, uint(15)).mul(uint(2)),
                  ), uint(3),
                ).toVar();
                const cls = select(occDyn.notEqual(uint(0)), uint(COV_OPAQUE), covRaw).toVar();
                const eFace = select(iAxis.equal(0), entryBits.x,
                  select(iAxis.equal(1), entryBits.y, entryBits.z)).toVar();
                // ⭐ THE ORIGIN VOXEL IS TESTED BY THE FACE THE RAY LEAVES BY.
                // Both bits of an axis pair are always set together (occlusion
                // along a line is reciprocal), so testing `entryBits[axisV]`
                // tests the AXIS the ray exits on, and keeps the faceId
                // convention every consumer already reads: the face whose
                // outward normal opposes the ray.
                const xFace = select(axisV.equal(0), entryBits.x,
                  select(axisV.equal(1), entryBits.y, entryBits.z)).toVar();
                const tFace = select(atOrigin, xFace, eFace).toVar();
                If(bitAnd(bitOr(fStatic, fDyn), shiftLeft(uint(1), tFace.toUint())).notEqual(uint(0)), () => {
                  // ⭐⭐ §AG — THE ONE BRANCH. Up to here the voxel has been
                  // decided to BLOCK this ray; the only remaining question is
                  // whether it is a SURFACE or something the surface bit was
                  // never meant to describe.
                  //
                  // An array cannot be indexed by a runtime value in WGSL — the
                  // same constraint `stepOf` works around — so the classes are
                  // a select chain over tier constants. ⚠ CLASS 3 FALLS OUT AT
                  // ATTENUATION 0, and that is not an oversight: `T` is the
                  // throughput TO the hit, so the opaque voxel that ends the ray
                  // must not also dim the radiance the caller reads at it.
                  let atten = float(0);
                  for (let c = 0; c < 3; c++) atten = select(cls.equal(uint(c)), float(COV_ATTEN[c]), atten);
                  thru.mulAssign(float(1).sub(atten));
                  // Opaque, or dimmed past the point where "it got through" is
                  // an honest answer. Both report the hit the old code did.
                  If(cls.equal(uint(COV_OPAQUE)).or(thru.lessThan(float(THROUGHPUT_MIN))), () => {
                    hit.assign(1);
                    // A ray blocked by the voxel it was born in is blocked at
                    // that voxel's far side, not at its own origin.
                    hitT.assign(tHit);
                    packed.assign(tFace.add(level.toFloat().mul(8)).add(vi.toFloat().mul(64)));
                    Break();
                  });
                  // …otherwise the DDA falls through and keeps walking. That is
                  // the whole of the cable slab's removal.
                });
              });

              If(tV.greaterThanEqual(tB), () => { Break(); }); // out of this brick
              vcell.addAssign(stepOf(axisV));
              iAxis.assign(axisV);
              tv0.assign(tV);
            });
          });

          firstVox.assign(0);
          If(hit.greaterThan(0.5), () => { Break(); });
          // Step to the next brick. `max` guards the one case where a level
          // hand-off re-derives a brick the ray has already passed: the brick
          // coordinate still advances, so the loop cannot stall.
          bcell.addAssign(stepOf(axisB));
          lastAxis.assign(axisB);
          t.assign(t.max(tB));
        });
      });

      // §AG's throughput rides in `w`'s FRACTION — see the RETURN SHAPE note.
      // `floor(w)` is still exactly the step count every existing reader wants.
      return vec4(hit, hitT, packed, used.add(thru.clamp(0, 1).mul(255).round().div(256)));
    },
  });

  /**
   * @param {Node} origin  world-space ray origin (ON the surface — the bias is
   *   applied here, not by the caller)
   * @param {Node} dir     UNIT direction; `t` is then metres
   * @param {Node|number} tMax
   * @param {Node} [normal]  geometric normal for the origin bias; omit for none
   * @param {Node|number} [biasCells]  origin bias in cells of the ORIGIN's own
   *   level (`v_l`), default half a cell. The escape above may push further.
   */
  const traceWindow = (origin, dir, tMax, normal = null, biasCells = DEFAULT_BIAS_CELLS) => {
    const r = traceFn(
      vec3(origin), vec3(dir), normal == null ? vec3(0, 0, 0) : vec3(normal), float(tMax),
      float(biasCells),
    ).toVar();
    const zi = r.z.toUint().toVar();
    return {
      hit: r.x,
      t: r.y,
      faceId: bitAnd(zi, uint(7)),
      level: bitAnd(shiftRight(zi, uint(3)), uint(7)),
      voxelIdx: shiftRight(zi, uint(6)),
      steps: r.w.floor(),
      /**
       * ⭐ §AG — HOW MUCH OF THE RAY SURVIVED THE THIN VOXELS ON THE WAY.
       *
       * 1 when nothing partial was crossed, which is every ray in every scene
       * that has no cables, railings or foliage in it — so a caller that
       * ignores this field gets exactly the answer it got before this stage,
       * which is why `traceWindow`'s old call sites did not have to move.
       *
       * A caller that uses it weights the HIT radiance by `T` and credits the
       * remaining `1 − T` to what the thin voxels were (their palette albedo
       * against the sky/parent estimate, or simply to the sky on a miss).
       */
      throughput: r.w.fract().mul(256 / 255).min(1),
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
    steps: Math.floor(w),
    // §AG — see the wrapper. `floor` is the step count, the fraction is T.
    throughput: Math.min(1, (w - Math.floor(w)) * (256 / 255)),
  };
}
