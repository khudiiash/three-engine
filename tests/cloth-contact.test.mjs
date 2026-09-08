/**
 * A CPU MODEL OF THE CLOTH CONTACT, BECAUSE THREE FIXES SHIPPED WITHOUT ONE.
 *
 * ⛔⛔ THE LESSON THIS FILE EXISTS FOR. In one session three solver changes
 * went to the live scene and all three had to be reverted: `__clothLra`
 * hoisted every curtain, `__clothOneSidedContact` wrecked even the pristine
 * island, and `__clothMaxStretch` produced 2 128 NaN particles. The constraint
 * solve had a CPU model by then (`relaxPass` in `cloth-mesh-topology.test.mjs`)
 * and it still blessed the NaN, because every fixture in it happened to hold
 * one end of the spring. The CONTACT had no model at all, so both
 * contact-side attempts were guesswork against a live scene with a person
 * watching it.
 *
 * `contactPass` mirrors `projectClothMeshContact` in `clothMeshContact.js`
 * line for line, minus the BVH — it walks every triangle, which is the same
 * answer. The fixtures pin what the real geometry does, including a MIS-WOUND
 * triangle: the thing that refuted the one-sided fix, and for which no fixture
 * existed beforehand.
 */
import test from "node:test";
import assert from "node:assert/strict";

const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const add = (p, q) => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const mul = (p, s) => [p[0] * s, p[1] * s, p[2] * s];
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const len = (p) => Math.hypot(p[0], p[1], p[2]);

/**
 * One contact projection, faithful to the kernel. `oneSided` takes the side
 * from the triangle WINDING (what `__clothOneSidedContact` does); the default
 * takes it from where the particle was, which is what ships.
 */
function contactPass(point, old, triangles, { radius = 0.02, friction = 0.2, oneSided = false, velocity = [0, 0, 0] } = {}) {
  const end = point.slice();
  let bestTime = 2, bestNormal = [0, 0, 0], bestAnchor = [0, 0, 0];
  const remember = (time, n, anchor) => {
    if (time < bestTime) { bestTime = time; bestNormal = n; bestAnchor = anchor; }
  };
  for (const [a, b, c] of triangles) {
    const ab = sub(b, a), ac = sub(c, a);
    const raw = cross(ab, ac), length = len(raw);
    if (!(length > 1e-6)) continue;
    const normal = mul(raw, 1 / length);
    const d0 = dot(sub(old, a), normal), d1 = dot(sub(end, a), normal);
    const side = oneSided ? 1 : (d0 >= 0 ? 1 : -1);
    const facing = mul(normal, side);
    const from = d0 * side, to = d1 * side;
    const denominator = from - to;
    const within = (p) => {
      const ap = sub(p, a), aa = dot(ab, ab), bb = dot(ac, ac), mixed = dot(ab, ac);
      const inverse = 1 / Math.max(aa * bb - mixed * mixed, 1e-12);
      const u = (bb * dot(ap, ab) - mixed * dot(ap, ac)) * inverse;
      const v = (aa * dot(ap, ac) - mixed * dot(ap, ab)) * inverse;
      return u >= -1e-5 && v >= -1e-5 && u + v <= 1.00001;
    };
    if (to < radius - 1e-6 && denominator > 1e-6) {
      const t = Math.min(1, Math.max(0, (from - radius) / denominator));
      const centre = add(old, mul(sub(end, old), t));
      const onPlane = sub(centre, mul(normal, dot(sub(centre, a), normal)));
      if (within(onPlane)) remember(t, facing, a);
    }
    const projected = sub(end, mul(normal, d1));
    if (Math.abs(d1) < radius - 1e-6 && within(projected)) {
      remember(1, facing, a);
    } else {
      let closest = a.slice(), best = 1e30;
      for (const [s, f] of [[a, b], [b, c], [c, a]]) {
        const edge = sub(f, s);
        const t = Math.min(1, Math.max(0, dot(sub(end, s), edge) / Math.max(dot(edge, edge), 1e-9)));
        const q = add(s, mul(edge, t)), d = dot(sub(end, q), sub(end, q));
        if (d < best) { best = d; closest = q; }
      }
      if (best < (radius - 1e-6) ** 2) {
        const delta = sub(end, closest), distance = Math.sqrt(best);
        remember(1, distance > 1e-6 ? mul(delta, 1 / distance) : facing, closest);
      }
    }
  }
  const out = { point: point.slice(), velocity: velocity.slice(), touched: bestTime <= 1 };
  if (bestTime <= 1) {
    const penetration = Math.max(0, radius - dot(sub(out.point, bestAnchor), bestNormal));
    out.point = add(out.point, mul(bestNormal, penetration));
    const inward = Math.min(0, dot(out.velocity, bestNormal));
    out.velocity = mul(sub(out.velocity, mul(bestNormal, inward)), 1 - friction);
  }
  return out;
}

/** A flat wall in the XY plane at z = 0, wound so its normal points to +Z. */
function wall({ misWound = false } = {}) {
  const p = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]];
  return misWound
    // The second triangle wound backwards: one bad face in an otherwise clean
    // wall, which is what a decimated collider actually contains.
    ? [[p[0], p[1], p[2]], [p[0], p[3], p[2]]]
    : [[p[0], p[1], p[2]], [p[0], p[2], p[3]]];
}

test("the model reproduces an ordinary contact: a particle moving in is stopped in front", () => {
  const { point, touched } = contactPass([0, 0, -0.01], [0, 0, 0.1], wall());
  assert.ok(touched, "the sweep missed a crossing it should have caught");
  assert.ok(point[2] >= 0.019, `ended at z ${point[2].toFixed(4)}, should be held at the contact radius`);
});

test("a particle far from the wall is left alone", () => {
  const { point } = contactPass([0, 0, 0.5], [0, 0, 0.5], wall());
  assert.ok(Math.abs(point[2] - 0.5) < 1e-9, "contact moved a particle nowhere near the wall");
});

test("⛔⛔ THE BISTABILITY: a particle already behind the wall is never recovered", () => {
  // THE BUG, isolated. Once a particle is further behind the wall than the
  // contact radius, the swept test finds no crossing (it did not cross during
  // this step) and the face test finds it outside the slab — so contact does
  // not touch it AT ALL. It is not pushed back to the wrong side; it is
  // ABANDONED there, and the only thing still acting on it is the spring to
  // its neighbours in front, which then spans the wall for good.
  //
  // ⚠ That is a correction to how this was described before the model existed:
  // "the contact pushes it back behind every substep". It does not push it
  // anywhere. The effect on the cloth is the same and the cause is not.
  let p = [0, 0, -0.05];
  for (let i = 0; i < 50; i++) {
    const r = contactPass(p, p, wall());
    assert.equal(r.touched, false, `step ${i}: contact engaged, so the model does not reproduce the bug`);
    p = r.point;
  }
  assert.ok(p[2] < 0, `the particle recovered on its own to z ${p[2]} — the model is wrong`);
});

test("⛔ a sweep that STARTS behind the wall cannot recover; one that starts in front does", () => {
  // Which is how the substep can inflict it on itself. The order is
  // `... collide, then four relaxation passes`; those passes move particles
  // with no contact after them, and the next substep's sweep starts from
  // `previous`, which the integrator has just set to that post-solve position.
  const behind = [0, 0, -0.05];
  assert.equal(contactPass(behind, [0, 0, -0.04], wall()).touched, false,
    "a sweep beginning behind the wall sees no crossing");
  const fromFront = contactPass(behind, [0, 0, 0.04], wall());
  assert.ok(fromFront.touched, "a sweep beginning in front does catch it");
  assert.ok(fromFront.point[2] >= 0.019);
});

test("⛔⛔ WHY THE WINDING FIX FAILED: one mis-wound triangle drives cloth INTO the wall", () => {
  // THE FIXTURE THAT DID NOT EXIST, and its absence cost a live regression —
  // taking the side from the winding wrecked even the pristine island
  // (worst spring 0.30 -> 17.25). A decimated collider is not consistently
  // wound and a single bad face is enough.
  //
  // ⚠ AND IT ONLY BITES WHERE THE BAD FACE IS THE ONLY ONE COVERING THE
  // PARTICLE. Tested at the quad's centre first, this passed — the correctly
  // wound triangle also covers that point and wins on earliest contact time,
  // hiding the fault. The particle has to sit over the mis-wound half alone,
  // which on a real collider is most of its area.
  const overBadFace = [-0.5, 0.5, -0.01], from = [-0.5, 0.5, 0.1];
  const shipped = contactPass(overBadFace, from, wall({ misWound: true }), { oneSided: false });
  assert.ok(shipped.point[2] >= 0.019, "the approach-side rule copes with a mis-wound face");

  const winding = contactPass(overBadFace, from, wall({ misWound: true }), { oneSided: true });
  assert.ok(
    winding.point[2] < 0,
    `the winding rule should drive this particle further behind, got z ${winding.point[2].toFixed(4)} — `
      + "if it no longer does, re-check the refutation before re-enabling __clothOneSidedContact",
  );
});

test("the approach-side rule keeps a particle legitimately under a floor", () => {
  // Why two-sidedness exists at all, and what any fix must preserve: an open
  // floor is a surface you can be beneath, not a volume.
  const under = contactPass([0, 0, -0.01], [0, 0, -0.1], wall());
  assert.ok(under.point[2] <= -0.019, `pushed up through the floor to z ${under.point[2].toFixed(4)}`);
});

/**
 * ── THE CANDIDATE: SWEEP FROM THE LAST KNOWN-GOOD POSITION ────────────────
 *
 * The model says the fault is DETECTION, not side selection: a particle behind
 * the wall is never touched, because the sweep `old -> end` lies entirely
 * behind and crosses nothing. Nothing about the winding, and nothing a
 * different `side` rule can reach.
 *
 * So give the sweep a better origin. Carry one extra per-particle position —
 * the last place this particle was known to be free of the geometry — and
 * sweep from THAT instead of from `previous`. In ordinary motion the two are
 * the same value, so nothing changes and there is no second traversal; they
 * diverge exactly when a particle has been moved somewhere invalid without
 * contact seeing it, which is the case that needs recovering.
 *
 * ⭐ AND IT NEEDS NO WINDING AND NO GLOBAL DECISION. The safe position is
 * seeded from the cloth's REST pose, so "which side does this cloth belong on"
 * is answered by how the asset was authored — which is exactly the question,
 * and the one a triangle normal was the wrong way to ask.
 */
function contactWithSafe(point, old, safe, triangles, opts = {}) {
  // `old` still supplies the velocity; `safe` supplies the sweep origin.
  const r = contactPass(point, safe, triangles, opts);
  return { ...r, safe: r.point.slice() };
}

test("⭐ a particle stranded behind the wall IS recovered when the sweep starts from safety", () => {
  // The failing case from above, with the only change being the sweep origin.
  const stranded = [0, 0, -0.05], previous = [0, 0, -0.04], safe = [0, 0, 0.06];
  assert.equal(contactPass(stranded, previous, wall()).touched, false, "the control: today it is abandoned");
  const fixed = contactWithSafe(stranded, previous, safe, wall());
  assert.ok(fixed.touched, "the recovery sweep must see the crossing");
  assert.ok(fixed.point[2] >= 0.019, `recovered to z ${fixed.point[2].toFixed(4)}`);
});

test("⭐ and cloth legitimately UNDER a floor is left under it", () => {
  // The case two-sidedness exists for, and the one the winding rule broke. A
  // cloth that was authored below the surface has a safe position below it
  // too, so the sweep crosses nothing and it is never hoisted through.
  const under = [0, 0, -0.1], safe = [0, 0, -0.08];
  const r = contactWithSafe(under, [0, 0, -0.09], safe, wall());
  assert.ok(r.point[2] < 0, `pushed up through the floor to z ${r.point[2].toFixed(4)}`);
});

test("⭐ and a mis-wound triangle changes nothing, because winding is never consulted", () => {
  // The refutation that cost a live regression cannot recur: this candidate
  // reads no normals for its side decision.
  const overBadFace = [-0.5, 0.5, -0.01];
  const r = contactWithSafe(overBadFace, [-0.5, 0.5, 0.1], [-0.5, 0.5, 0.1], wall({ misWound: true }));
  assert.ok(r.point[2] >= 0.019, `a mis-wound face still resolves correctly, got z ${r.point[2].toFixed(4)}`);
});

test("ordinary contact is unchanged, because safe and previous coincide in normal motion", () => {
  // The performance argument, and the compatibility one: the safe position is
  // updated to the resolved point every step, so in steady motion it IS the
  // previous position and the sweep is bit-for-bit the one that ships today.
  const point = [0, 0, -0.01], previous = [0, 0, 0.1];
  const today = contactPass(point, previous, wall());
  const candidate = contactWithSafe(point, previous, previous, wall());
  assert.deepEqual(candidate.point, today.point);
  assert.equal(candidate.touched, today.touched);
});

test("the safe position tracks the resolved point, so it never records a bad place", () => {
  // If `safe` were updated to wherever the particle ended up regardless, one
  // undetected tunnel would poison it forever and recovery would never fire
  // again. It is set from the RESOLVED point, which the sweep has just
  // certified.
  let safe = [0, 0, 0.5], p = [0, 0, 0.5];
  for (const target of [[0, 0, 0.3], [0, 0, 0.1], [0, 0, -0.2]]) {
    const r = contactWithSafe(target, p, safe, wall());
    p = r.point; safe = r.safe;
    assert.ok(safe[2] > 0, `safe drifted behind the wall to z ${safe[2].toFixed(4)}`);
  }
  assert.ok(p[2] >= 0.019, "and the particle ends held in front");
});

/**
 * ── WHY REPLACING THE ORIGIN OVER-FIRED, AND THE VERSION THAT DOES NOT ─────
 *
 * Sweeping from `safe` INSTEAD of `previous` fixed every free-hanging curtain
 * (strain 0.015-0.020, the best of the session) and hoisted every wall-pressed
 * one to a centre height of ~3.0 m. The model says why: a longer sweep can
 * reach a triangle the short one never came near, `remember` keeps the
 * EARLIEST crossing, and the push is then measured against THAT triangle's
 * plane — `penetration = radius - dot(point - anchor, normal)`. Against a
 * perpendicular wall a metre away that is a metre-sized shove.
 *
 * So the origin is not replaced. The sweep from `previous` stays exactly as it
 * ships and keeps first refusal; `safe` is consulted only when it finds
 * NOTHING, which is precisely the stranded case and nothing else.
 */
function contactFallback(point, old, safe, triangles, opts = {}) {
  const primary = contactPass(point, old, triangles, opts);
  if (primary.touched) return { ...primary, safe: primary.point.slice() };
  const recovery = contactPass(point, safe, triangles, opts);
  return recovery.touched
    ? { ...recovery, safe: recovery.point.slice(), recovered: true }
    : { ...primary, safe: point.slice() };
}

/** A corner: the wall at z = 0 plus a side wall at x = 0, as in an alcove. */
function alcove() {
  const back = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]];
  const side = [[0, -1, 0], [0, -1, 2], [0, 1, 2], [0, 1, 0]];
  return [
    [back[0], back[1], back[2]], [back[0], back[2], back[3]],
    [side[0], side[1], side[2]], [side[0], side[2], side[3]],
  ];
}

test("⛔ THE OVER-FIRE: a long sweep can hit a perpendicular wall and shove by its distance", () => {
  // A particle sitting quietly against the BACK wall of an alcove, whose safe
  // position is a little way along the side wall. Replacing the origin makes
  // the sweep cross the SIDE wall, and the push is then measured against the
  // side wall's plane rather than the back wall's.
  const point = [0.4, 0, 0.01], previous = [0.42, 0, 0.03], safe = [-0.4, 0, 0.5];
  const replaced = contactPass(point, safe, alcove());
  const shipped = contactPass(point, previous, alcove());
  const moved = (r) => Math.hypot(r.point[0] - point[0], r.point[1] - point[1], r.point[2] - point[2]);
  assert.ok(replaced.touched && shipped.touched, "both should find some contact here");
  assert.ok(
    moved(replaced) > moved(shipped) * 5,
    `replacing the origin should shove far harder: ${moved(shipped).toFixed(4)} m vs ${moved(replaced).toFixed(4)} m`,
  );
});

test("⭐ the FALLBACK form leaves ordinary contact exactly as it ships", () => {
  // The whole safety argument: when the sweep from `previous` finds anything,
  // that is the answer, bit for bit. Nothing an alcove does can change it.
  const point = [0.4, 0, 0.01], previous = [0.42, 0, 0.03], safe = [-0.4, 0, 0.5];
  const shipped = contactPass(point, previous, alcove());
  const fallback = contactFallback(point, previous, safe, alcove());
  assert.deepEqual(fallback.point, shipped.point);
  assert.ok(!fallback.recovered, "the fallback must not have run");
});

test("⭐ and it still recovers a particle stranded behind the wall", () => {
  // The case the whole exercise is for, unchanged by the reordering.
  const stranded = [0, 0, -0.05], previous = [0, 0, -0.04], safe = [0, 0, 0.06];
  assert.equal(contactPass(stranded, previous, wall()).touched, false, "the control: today it is abandoned");
  const r = contactFallback(stranded, previous, safe, wall());
  assert.ok(r.recovered, "the fallback did not fire on a stranded particle");
  assert.ok(r.point[2] >= 0.019, `recovered to z ${r.point[2].toFixed(4)}`);
});

test("⭐ cloth authored under a floor is still left under it", () => {
  const under = [0, 0, -0.1];
  const r = contactFallback(under, [0, 0, -0.09], [0, 0, -0.08], wall());
  assert.ok(r.point[2] < 0, `pushed up through the floor to z ${r.point[2].toFixed(4)}`);
});

test("⭐ a free particle nowhere near anything advances its safe position", () => {
  // Otherwise the origin staleness the over-fire came from would only grow.
  const r = contactFallback([0, 0, 0.5], [0, 0, 0.6], [0, 0, 0.8], wall());
  assert.equal(r.touched, false);
  assert.deepEqual(r.safe, [0, 0, 0.5]);
});

/**
 * ⛔⛔ WHAT THE RECOVERY SWEEP'S GUARD ACTUALLY MEASURES.
 *
 * The stranded-particle recovery in `gridSimulation`'s `collide` runs only when
 * the ordinary sweep found nothing AND `drift = sweepFrom - old` exceeds a
 * contact radius. Its comment says that on a settled cloth this is
 * sub-millimetre and never fires, which is true — and it is the whole of the
 * truth only while the cloth is settled.
 *
 * The bookkeeping is what makes it so. At the end of every `collide`:
 *
 *     positions  := point
 *     previous   := point - velocity
 *     clothSafe  := point
 *
 * so on the NEXT step `sweepFrom` (from `clothSafe`) minus `old` (from
 * `previous`) is exactly the last step's velocity. The guard is a SPEED test
 * wearing the clothes of a straying test, and a shoved curtain passes it
 * everywhere.
 *
 * Reported as: "like a rubber band ... some unknown force is pulling its bottom
 * edge to its original position, and pulls harder when the cloth gets further
 * from where it wants to be (upon contact with character collider)" (user,
 * 2026-09-08).
 */
test("⛔⛔ the recovery's `drift` is one step's motion, so its gate is a SPEED test", () => {
  // The three writes `collide` makes, in the order it makes them.
  const step = (point, velocity) => ({
    positions: point,
    previous: point - velocity,
    clothSafe: point,
  });

  // A settled cloth: it barely moves, and the guard is quiet.
  let state = step(1.0, 0.0002);
  let drift = state.clothSafe - state.previous;
  assert.ok(Math.abs(drift) < 0.001, `a settled cloth drifts ${drift}`);

  // A shoved one: the SAME bookkeeping, and drift is now the shove speed.
  const perStep = 0.05; // 5 cm in one substep — an ordinary character push
  state = step(1.4, perStep);
  drift = state.clothSafe - state.previous;
  assert.ok(Math.abs(drift - perStep) < 1e-12,
    `drift must equal the last step's motion exactly, got ${drift} for a ${perStep} step`);

  // ⭐ THE POINT: the threshold is this cloth's capped contact radius, 1.2 cm.
  // Anything faster arms the recovery — and that is a speed, not a distance
  // from safety.
  const CONTACT_RADIUS = 0.012;
  assert.ok(Math.abs(drift) > CONTACT_RADIUS,
    "a 5 cm substep must trip a 1.2 cm gate — this is what fires during a shove");

  // Two substeps a frame at 60 fps, so the gate corresponds to ~1.4 m/s.
  const substepsPerSecond = 120;
  const speedThreshold = CONTACT_RADIUS * substepsPerSecond;
  assert.ok(speedThreshold > 1.3 && speedThreshold < 1.5,
    `the gate is about ${speedThreshold.toFixed(2)} m/s, not a measure of straying`);
});

/**
 * ⛔⛔ "STRETCH STIFFNESS" HAS TO CHANGE THE STRETCH.
 *
 * It did not. `constrainMesh` weighted each spring by
 * `mix(stiffness, bend, family)`, summed those weights into `total`, and then
 * divided the accumulated correction by `total` — so a value every spring
 * shares cancels exactly. With bend at 0, every active spring carries
 * `stiffness` and the control was completely inert.
 *
 * Measured on the user's own curtain before the fix: drag a patch 1.5 m, relax
 * eight passes, and the worst structural spring sits at 8.4770x rest length at
 * stiffness 0.10, 0.50, 0.95 AND 1.00 — identical to four decimal places.
 *
 * "see it stretches when player walked through it? it must not do that, I set
 * stretching to 0" (user, 2026-09-08). The setting was at maximum and doing
 * nothing.
 */
test("⛔⛔ stretch stiffness is not allowed to cancel out of the Jacobi average", () => {
  // The kernel's arithmetic for one particle, both ways round.
  const springs = [
    { rest: 1, len: 2.0, family: 0 },   // structural, stretched 2x
    { rest: 1, len: 1.5, family: 0 },
    { rest: 1, len: 1.2, family: 1 },   // a bend spring
  ];
  const correct = (stiffness, bend, { weightIsStiffness }) => {
    let correction = 0, total = 0;
    for (const s of springs) {
      const w = weightIsStiffness
        ? stiffness + s.family * (bend - stiffness)   // the OLD weight
        : 1 + s.family * (bend - 1);                  // family ratio only
      correction += (s.len - s.rest) * w;
      total += w;
    }
    const averaged = correction / Math.max(total, 1e-4);
    return weightIsStiffness ? averaged : averaged * stiffness;
  };

  // THE BUG, stated as arithmetic: with bend 0, the old form is a constant.
  const oldSoft = correct(0.1, 0, { weightIsStiffness: true });
  const oldStiff = correct(1.0, 0, { weightIsStiffness: true });
  assert.ok(Math.abs(oldSoft - oldStiff) < 1e-12,
    "the old weighting really did cancel — this is the control, not the fix");

  // THE FIX: a tenth of the stiffness moves a tenth as far.
  const soft = correct(0.1, 0, { weightIsStiffness: false });
  const stiff = correct(1.0, 0, { weightIsStiffness: false });
  assert.ok(stiff > soft * 5, `stiffness must scale the correction; got ${soft} vs ${stiff}`);
  assert.ok(Math.abs(soft / stiff - 0.1) < 1e-9, "and scale it linearly");

  // ⚠ AND IT MUST NOT MOVE THE DEFAULT LOOK. At stiffness 1 the new form is
  // the old one exactly, which is what makes this safe to ship.
  assert.ok(Math.abs(stiff - correct(1.0, 0, { weightIsStiffness: true })) < 1e-12,
    "at stiffness 1 the two forms must agree bit for bit");
});
