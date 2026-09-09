import { SPRING_END } from "./clothMeshTopology.js";

/**
 * ⭐⭐⭐ TEN CLOTHS, ONE SET OF DISPATCHES.
 *
 * Every mesh cloth builds its own kernels over its own buffers, so a scene with
 * ten curtains issues ten times the dispatches for the same work. Measured on
 * the user's Sponza with `profile.frameCensus` on 2026-09-09: **165 dispatches
 * a frame, 21.97 ms of a 30.3 ms frame, and 120 fps the moment cloth stops** —
 * and the cost tracks the number of cloths ON SCREEN, not the number of
 * particles. At ~2300 particles a cloth a dispatch costs ~117 us for work that
 * should take single-digit microseconds: it is launch and barrier overhead, not
 * arithmetic.
 *
 * Two other explanations were ruled out first, each by measurement:
 *   - the shared SUBMISSION (one `renderer.compute` for every cloth) bought
 *     ~1 ms of 22, so the cost is per DISPATCH, not per submit;
 *   - disabling 2800 of 3609 collider triangles bought 3.3 ms of 22, so the
 *     BVH contact is ~15 % of it and not the driver either.
 *
 * So: concatenate every cloth that shares a solver configuration into ONE
 * particle set and run the solver over all of them at once. Ten cloths of 2300
 * particles become one of 23000 — the same arithmetic, a tenth of the launches,
 * and a GPU that is finally occupied.
 *
 * ⚠ THE MEMBERS MUST SHARE A SPACE. Each cloth's rest pose is baked through its
 * own matrix into the flock's space, and the render side undoes it per cloth,
 * so a cloth keeps its own entity transform. Spring rest lengths, fabric runs
 * and contact radii are LENGTHS and are scaled with the matrix; only a uniform
 * scale is admitted, because a non-uniform one has no single length factor and
 * would quietly stretch the fabric.
 */

/** The largest axis-scale mismatch tolerated before a member is rejected. */
const SCALE_TOLERANCE = 1e-3;

/**
 * The uniform scale of a column-major 4x4, or null when its axes do not share
 * one — a cloth scaled 2x in X alone has no single factor for a rest length,
 * so it cannot join a flock and keeps its own solver.
 */
export function uniformScaleOf(matrix) {
  if (!matrix) return 1;
  const sx = Math.hypot(matrix[0], matrix[1], matrix[2]);
  const sy = Math.hypot(matrix[4], matrix[5], matrix[6]);
  const sz = Math.hypot(matrix[8], matrix[9], matrix[10]);
  if (Math.abs(sx - sy) > SCALE_TOLERANCE * Math.max(1, sx)) return null;
  if (Math.abs(sx - sz) > SCALE_TOLERANCE * Math.max(1, sx)) return null;
  return sx;
}

/** Column-major 4x4 applied to (x, y, z, 1), written into `out`. */
function transformPoint(m, x, y, z, out) {
  if (!m) { out[0] = x; out[1] = y; out[2] = z; return out; }
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/**
 * Concatenate packed cloth topologies into one the solver can run in a single
 * set of dispatches.
 *
 * @param {Array<{topology: object, matrix?: ArrayLike<number>|null}>} members
 * @returns {{topology: object, ranges: Array<{base: number, count: number, scale: number, cloth: number}>}}
 */
export function mergeClothTopologies(members) {
  if (!Array.isArray(members) || members.length === 0) throw new Error("mergeClothTopologies: no members");
  const scales = members.map((member) => {
    const scale = uniformScaleOf(member.matrix);
    if (scale === null) throw new Error("mergeClothTopologies: a member has non-uniform scale");
    return scale;
  });

  const count = members.reduce((total, m) => total + m.topology.count, 0);
  // ⚠ ONE STRIDE FOR THE WHOLE FLOCK. The spring table is addressed as
  // `particle * stride + slot`, so a member packed at a SMALLER stride has to
  // be re-packed at the flock's rather than copied — a straight copy would
  // read the next particle's springs as its own.
  const stride = members.reduce((total, m) => Math.max(total, m.topology.stride), 1);
  const hasLra = members.some((m) => m.topology.lra);
  const hasRadius = members.some((m) => m.topology.contactRadius);

  const rest = new Float32Array(count * 4);
  const springs = new Float32Array(count * stride * 4);
  const lra = hasLra ? new Float32Array(count * 4) : null;
  const contactRadius = hasRadius ? new Float32Array(count) : null;
  /** Which cloth each particle belongs to, for anything per-cloth in a shared kernel. */
  const clothOf = new Float32Array(count);

  const ranges = [];
  const point = [0, 0, 0];
  let base = 0;
  members.forEach((member, cloth) => {
    const t = member.topology;
    const m = member.matrix ?? null;
    const scale = scales[cloth];
    for (let v = 0; v < t.count; v++) {
      const g = base + v;
      transformPoint(m, t.rest[v * 4], t.rest[v * 4 + 1], t.rest[v * 4 + 2], point);
      rest[g * 4] = point[0];
      rest[g * 4 + 1] = point[1];
      rest[g * 4 + 2] = point[2];
      rest[g * 4 + 3] = t.rest[v * 4 + 3];        // the pin flag is not a length
      clothOf[g] = cloth;
      if (contactRadius) contactRadius[g] = (t.contactRadius ? t.contactRadius[v] : 0) * scale;
      if (lra) {
        if (t.lra) {
          transformPoint(m, t.lra[v * 4], t.lra[v * 4 + 1], t.lra[v * 4 + 2], point);
          lra[g * 4] = point[0];
          lra[g * 4 + 1] = point[1];
          lra[g * 4 + 2] = point[2];
          lra[g * 4 + 3] = t.lra[v * 4 + 3] * scale;   // a fabric run IS a length
        } else {
          // A member without long-range attachments must read as "no cap", not
          // as a cap toward the origin: w = 0 is the solver's own off switch.
          lra[g * 4] = 0; lra[g * 4 + 1] = 0; lra[g * 4 + 2] = 0; lra[g * 4 + 3] = 0;
        }
      }
      const from = v * t.stride * 4;
      const to = g * stride * 4;
      for (let slot = 0; slot < stride; slot++) {
        if (slot >= t.stride || t.springs[from + slot * 4] === SPRING_END) {
          // ⛔ EVERY unused slot carries the sentinel. A zero-filled slot reads
          // as a spring to PARTICLE 0 with a rest length of zero and drags the
          // whole flock into one point — the same fault that once tore the
          // curtains into vertical threads.
          springs[to + slot * 4] = SPRING_END;
          springs[to + slot * 4 + 1] = 0;
          springs[to + slot * 4 + 2] = 0;
          springs[to + slot * 4 + 3] = 0;
          continue;
        }
        springs[to + slot * 4] = t.springs[from + slot * 4] + base;   // GLOBAL index
        springs[to + slot * 4 + 1] = t.springs[from + slot * 4 + 1] * scale;
        springs[to + slot * 4 + 2] = t.springs[from + slot * 4 + 2];
        // The successor is a SLOT within this particle's own fan, or a
        // sentinel. It is not an index into the particle table, so it is
        // carried through untouched.
        springs[to + slot * 4 + 3] = t.springs[from + slot * 4 + 3];
      }
    }
    ranges.push({ base, count: t.count, scale, cloth });
    base += t.count;
  });

  return {
    topology: {
      count, stride, rest, springs, lra, contactRadius, clothOf,
      shellThickness: members[0].topology.shellThickness ?? 0,
      // Render-side tables stay with their own cloth: each member keeps its own
      // geometry, its own seams and its own surface kernel.
      simIndex: null, shellOffset: null, renderCount: 0,
    },
    ranges,
  };
}

/**
 * Cloths may share a solver only when every uniform that solver reads is the
 * same for all of them, because a flock has exactly one set. This is the
 * grouping key; anything that reaches a solver uniform belongs in it.
 */
/**
 * ⛔ QUANTISE MEASURED VALUES. `shellThickness` is MEASURED off the geometry,
 * not authored, so nine Sponza curtains cut from two real shells produced nine
 * different keys — 0.028830057 against 0.028830083 — and every cloth ended up
 * alone in its own flock, which is exactly the state the flock exists to
 * escape. Anything that comes off a mesh needs a tolerance; a tenth of a
 * millimetre is far below what a cap on contact can express.
 */
const SHELL_STEP = 1e-4;

export function flockKey(props = {}, topology = null) {
  return JSON.stringify([
    props.stiffness ?? null, props.bend ?? null, props.damping ?? null,
    props.gravity ?? null, props.wind ?? null, props.gust ?? null,
    props.gustFrequency ?? null, props.pinning ?? props.pin ?? null,
    props.friction ?? null, props.thickness ?? null, props.collisionRadius ?? null,
    Math.round((topology?.shellThickness ?? 0) / SHELL_STEP),
  ]);
}
