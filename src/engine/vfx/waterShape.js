import { If, float, select, vec2, vec3 } from "three/tsl";

/**
 * ══ THE WATER'S SHAPE, IN TSL ══════════════════════════════════════════════
 *
 * "Make it work for other primitive geometries like cylinder, sphere, cone"
 * (user, 2026-09-06). The GPU half of `waterVolume.js`'s shape: every
 * consumer that used to ask "is this point in the box" — the lid's rim, the
 * solver's wall, the medium's ray clip, the caustic receivers, the contact
 * foam — asks these instead, from one `shape` uniform:
 *
 *     shape = (kind, radius, centerY, height)      LOCAL units, origin ON the lid
 *
 * `kind` 0 box · 1 cylinder · 2 sphere · 3 cone (apex +Y) · 4 capsule. A
 * solid of revolution is its PROFILE ρ(y) — the cross-section radius at a
 * height — and the lid is the cross-section at y = 0. `centerY` is where the
 * primitive's own centre sits below the lid, which is what `fill` moves.
 */

/** The cross-section radius at local height `y` (box: the radius, unused). */
export function waterProfileRadiusNode(shape, y) {
  const kind = shape.x, r = shape.y, q = float(y).sub(shape.z), h = shape.w.max(1e-4);
  const sphere = r.mul(r).sub(q.mul(q)).max(0).sqrt();
  const cone = r.mul(h.mul(.5).sub(q)).div(h).max(0);
  const halfCylinder = h.sub(r.mul(2)).max(0).mul(.5);
  const capsule = r.mul(r).sub(q.abs().sub(halfCylinder).max(0).pow(2)).max(0).sqrt();
  return select(kind.lessThan(1.5), r, select(kind.lessThan(2.5), sphere, select(kind.lessThan(3.5), cone, capsule)));
}

/** Signed distance INSIDE the lid's outline at local (x, z): positive inside. */
export function waterRimDistanceNode(shape, half, x, z) {
  const box = half.x.sub(float(x).abs()).min(half.z.sub(float(z).abs()));
  const round = waterProfileRadiusNode(shape, float(0)).sub(vec2(x, z).length());
  return select(shape.x.lessThan(.5), box, round);
}

/** Is a local point in the water: below the lid and inside the profile there. */
export function waterInsideNode(shape, half, p) {
  const point = vec3(p);
  const under = point.y.lessThan(0);
  const box = point.x.abs().lessThan(half.x).and(point.z.abs().lessThan(half.z));
  const round = vec2(point.x, point.z).length().lessThan(waterProfileRadiusNode(shape, point.y));
  const isBox = shape.x.lessThan(.5);
  return under.and(isBox.and(box).or(isBox.not().and(round)));
}

// ── THE MEDIUM'S RAY CLIP ─────────────────────────────────────────────────
//
// `waterSegmentNode` clips the eye→fragment segment [t0, t1] against slabs;
// a solid of revolution adds one quadric. All exact: a cylinder and a sphere
// are one quadratic each, a cone is a quadratic whose leading coefficient can
// go NEGATIVE (a ray steeper than the cone's side is inside on one SIDE of
// its roots, and the lower nappe is the side where y is below the apex), and
// a capsule is the convex union of a cylinder and two spheres — one interval
// from the earliest entry to the latest exit among the pieces that are hit.

function clipSlab(t0, t1, origin, delta, min, max) {
  const safe = select(delta.abs().lessThan(1e-6), select(delta.greaterThanEqual(0), float(1e-6), float(-1e-6)), delta);
  const inv = float(1).div(safe);
  const lo = min.sub(origin).mul(inv), hi = max.sub(origin).mul(inv);
  t0.assign(t0.max(lo.min(hi)));
  t1.assign(t1.min(lo.max(hi)));
}
const empty = (t0, t1) => t1.assign(t0.sub(1));

/** Clip [t0, t1] to { t : A t² + B t + C ≤ 0 }; `lowerSide` (±1) picks the
 *  half-line when A < 0 (cone): +1 keeps t ≤ the smaller root. */
function clipQuadratic(t0, t1, A, B, C, lowerSide) {
  const disc = B.mul(B).sub(A.mul(C).mul(4));
  If(A.abs().greaterThan(1e-7), () => {
    If(disc.lessThan(0), () => {
      // No roots: the whole ray is outside (A > 0) or inside (A < 0).
      If(A.greaterThan(0), () => { empty(t0, t1); });
    }).Else(() => {
      const s = disc.sqrt();
      const ra = B.negate().sub(s).div(A.mul(2)), rb = B.negate().add(s).div(A.mul(2));
      const lo = ra.min(rb), hi = ra.max(rb);
      If(A.greaterThan(0), () => { t0.assign(t0.max(lo)); t1.assign(t1.min(hi)); })
        .Else(() => { If(lowerSide.greaterThan(0), () => { t1.assign(t1.min(lo)); }).Else(() => { t0.assign(t0.max(hi)); }); });
    });
  }).Else(() => {
    // Linear: B t + C ≤ 0.
    If(B.abs().greaterThan(1e-9), () => {
      const root = C.negate().div(B);
      If(B.greaterThan(0), () => { t1.assign(t1.min(root)); }).Else(() => { t0.assign(t0.max(root)); });
    }).Else(() => { If(C.greaterThan(0), () => { empty(t0, t1); }); });
  });
}
function clipCylinder(t0, t1, a, d, r) {
  const A = d.x.mul(d.x).add(d.z.mul(d.z)), B = a.x.mul(d.x).add(a.z.mul(d.z)).mul(2), C = a.x.mul(a.x).add(a.z.mul(a.z)).sub(r.mul(r));
  clipQuadratic(t0, t1, A, B, C, float(0));
}
function clipSphere(t0, t1, a, d, centre, r) {
  const o = a.sub(centre);
  clipQuadratic(t0, t1, d.dot(d), o.dot(d).mul(2), o.dot(o).sub(r.mul(r)), float(0));
}
function clipCone(t0, t1, a, d, apexY, k) {
  const qa = apexY.sub(a.y), k2 = k.mul(k);
  const A = d.x.mul(d.x).add(d.z.mul(d.z)).sub(k2.mul(d.y).mul(d.y));
  const B = a.x.mul(d.x).add(a.z.mul(d.z)).add(k2.mul(qa).mul(d.y)).mul(2);
  const C = a.x.mul(a.x).add(a.z.mul(a.z)).sub(k2.mul(qa).mul(qa));
  clipQuadratic(t0, t1, A, B, C, select(d.y.greaterThan(0), float(1), float(-1)));
}

/** Clip the local segment a + t·d, t ∈ [t0, t1], to the solid's profile. */
export function clipShapeNode(shape, t0, t1, a, d) {
  const kind = shape.x, r = shape.y, cy = shape.z, h = shape.w.max(1e-4);
  If(kind.greaterThan(.5), () => {
    // ⚠ Every `If` body here is a BLOCK: an arrow that returns the assign
    // node makes TSL read the `If` as a typed expression ("expected a float").
    If(kind.lessThan(1.5), () => { clipCylinder(t0, t1, a, d, r); })
      .ElseIf(kind.lessThan(2.5), () => { clipSphere(t0, t1, a, d, vec3(0, cy, 0), r); })
      .ElseIf(kind.lessThan(3.5), () => { clipCone(t0, t1, a, d, cy.add(h.mul(.5)), r.div(h)); })
      .Else(() => {
        const halfCylinder = h.sub(r.mul(2)).max(0).mul(.5);
        const c0 = t0.toVar(), c1 = t1.toVar();
        clipCylinder(c0, c1, a, d, r); clipSlab(c0, c1, a.y, d.y, cy.sub(halfCylinder), cy.add(halfCylinder));
        const p0 = t0.toVar(), p1 = t1.toVar();
        clipSphere(p0, p1, a, d, vec3(0, cy.add(halfCylinder), 0), r);
        const q0 = t0.toVar(), q1 = t1.toVar();
        clipSphere(q0, q1, a, d, vec3(0, cy.sub(halfCylinder), 0), r);
        const big = float(1e9);
        const entry = select(c1.greaterThanEqual(c0), c0, big).min(select(p1.greaterThanEqual(p0), p0, big)).min(select(q1.greaterThanEqual(q0), q0, big));
        const exit = select(c1.greaterThanEqual(c0), c1, big.negate()).max(select(p1.greaterThanEqual(p0), p1, big.negate())).max(select(q1.greaterThanEqual(q0), q1, big.negate()));
        If(exit.lessThan(entry), () => { empty(t0, t1); }).Else(() => { t0.assign(t0.max(entry)); t1.assign(t1.min(exit)); });
      });
  });
}
