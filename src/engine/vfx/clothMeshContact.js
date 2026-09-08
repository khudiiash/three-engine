import { Break, If, Loop, dot, float, int, vec3 } from "three/tsl";

/** Swept, two-sided triangle contacts over the field's stackless BVH.
 * Expands the swept bounds by contact thickness; triangle tests preserve holes.
 * Face crossings cannot tunnel through an infinitely thin triangle. Final edge
 * contacts cover resting vertices near triangle borders (not swept edge CCD).
 */
export function projectClothMeshContact({ field, skip, point, old, velocity, radius, friction }) {
  const end = vec3(point).toVar();
  const sweepMin = old.min(end).sub(radius), sweepMax = old.max(end).add(radius);
  const bestTime = float(2).toVar(), bestNormal = vec3(0).toVar(), bestAnchor = vec3(0).toVar();
  const cursor = int(0).toVar();
  const remember = (time, normal, anchor) => {
    If(time.lessThan(bestTime), () => { bestTime.assign(time); bestNormal.assign(normal); bestAnchor.assign(anchor); });
  };
  Loop({ start: 0, end: field.countUniform }, () => {
    If(cursor.greaterThanEqual(field.countUniform), () => { Break(); });
    const base = cursor.mul(5);
    const low = field.buffer.element(base), high = field.buffer.element(base.add(1));
    const escape = low.w.toInt();
    const overlap = sweepMax.x.greaterThanEqual(low.x).and(sweepMin.x.lessThanEqual(high.x))
      .and(sweepMax.y.greaterThanEqual(low.y)).and(sweepMin.y.lessThanEqual(high.y))
      .and(sweepMax.z.greaterThanEqual(low.z)).and(sweepMin.z.lessThanEqual(high.z));
    If(overlap, () => {
      If(high.w.greaterThan(.5), () => {
        const ar = field.buffer.element(base.add(2)), br = field.buffer.element(base.add(3)), cr = field.buffer.element(base.add(4));
        If(cr.w.toInt().notEqual(skip), () => {
          const a = ar.xyz, b = br.xyz, c = cr.xyz;
          const ab = b.sub(a), ac = c.sub(a);
          const rawNormal = ab.cross(ac), length = rawNormal.length();
          If(length.greaterThan(.000001), () => {
            const normal = rawNormal.div(length);
            const d0 = dot(old.sub(a), normal), d1 = dot(end.sub(a), normal);
            // ⛔⛔ A TWO-SIDED CONTACT IS BISTABLE, AND THE WRONG STATE IS
            // STABLE.
            //
            // The side used to come from `d0` alone — where the particle WAS.
            // That is right for a floor you can legitimately be under, and
            // catastrophic for a wall a curtain is pressed against: once a
            // particle ends up behind the wall, its `old` is behind too, so
            // the contact dutifully pushes it BACK behind, every substep,
            // forever. Its neighbours stay in front and the spring between
            // them spans the wall for good. Every curtain that breaks in
            // Sponza is one the wind presses into a wall; the ones hanging
            // free are clean, and a held particle measures 3.63x rest length
            // with no path back (see `relaxHeld` in the topology tests).
            //
            // ⛔⛔ AND THE OBVIOUS FIX IS REFUTED, MEASURED, ON THE LIVE
            // SCENE. Taking the side from the triangle's WINDING instead —
            // "a cloth belongs on the side a scene collider's normal points" —
            // assumes a cooked collider is wound consistently. Sponza's are
            // not. Shipped as the default for one reload and every island got
            // worse, the previously PRISTINE one worst of all:
            //
            //     island 2   mean strain 0.014 -> 0.174   worst 0.30 -> 17.25
            //     island 0   mean strain 0.077 -> 0.171   worst 7.24 -> 21.98
            //
            // A wrongly wound triangle pushes cloth INTO the wall, and there
            // are enough of them in a decimated collider to wreck every piece.
            // So the approach side stays the default; `__clothOneSidedContact`
            // opts into the winding for geometry known to be clean.
            //
            // ⚠ "Prefer the front unless BOTH ends are behind" was tried first
            // and is not even a candidate: a stuck particle has both ends
            // behind, which is the entire condition.
            //
            // ▶ The bistability is REAL and still unfixed — see the plan doc.
            // Whatever replaces this needs a CPU model of the contact to test
            // against, the way `relaxPass` models the constraint solve. Two
            // speculative solver changes in a row shipped and had to be
            // reverted; that is the lesson, not the hypotheses.
            const side = globalThis.__clothOneSidedContact === true
              ? float(1)
              : d0.greaterThanEqual(0).select(1, -1);
            const facing = normal.mul(side);
            const from = d0.mul(side), to = d1.mul(side);
            const denominator = from.sub(to);
            const within = (p) => {
              const ap = p.sub(a), aa = dot(ab, ab), bb = dot(ac, ac), mixed = dot(ab, ac);
              const inverse = aa.mul(bb).sub(mixed.mul(mixed)).max(.000000000001).reciprocal();
              const u = bb.mul(dot(ap, ab)).sub(mixed.mul(dot(ap, ac))).mul(inverse);
              const v = aa.mul(dot(ap, ac)).sub(mixed.mul(dot(ap, ab))).mul(inverse);
              return u.greaterThanEqual(-.00001).and(v.greaterThanEqual(-.00001)).and(u.add(v).lessThanEqual(1.00001));
            };
            // Contact at the first thickness-offset plane crossing, not merely
            // when the final vertex happens to remain inside a thin slab.
            If(to.lessThan(radius.sub(.000001)).and(denominator.greaterThan(.000001)), () => {
              const t = from.sub(radius).div(denominator).clamp(0, 1);
              const center = old.add(end.sub(old).mul(t));
              const onPlane = center.sub(normal.mul(dot(center.sub(a), normal)));
              If(within(onPlane), () => { remember(t, facing, a); });
            });
            const projected = end.sub(normal.mul(d1));
            If(d1.abs().lessThan(radius.sub(.000001)).and(within(projected)), () => {
              remember(float(1), facing, a);
            }).Else(() => {
              // Closest boundary segment handles contacts along open borders
              // without turning a concave opening into a solid bounding box.
              const closest = vec3(a).toVar(), distanceSq = float(1e30).toVar();
              for (const [start, finish] of [[a, b], [b, c], [c, a]]) {
                const edge = finish.sub(start);
                const t = dot(end.sub(start), edge).div(dot(edge, edge).max(.000000001)).clamp(0, 1);
                const q = start.add(edge.mul(t)), dist = dot(end.sub(q), end.sub(q));
                If(dist.lessThan(distanceSq), () => { distanceSq.assign(dist); closest.assign(q); });
              }
              If(distanceSq.lessThan(radius.sub(.000001).pow(2)), () => {
                const delta = end.sub(closest), distance = distanceSq.sqrt();
                const edgeNormal = distance.greaterThan(.000001).select(delta.div(distance.max(.000001)), facing);
                remember(float(1), edgeNormal, closest);
              });
            });
          });
        });
        cursor.assign(escape);
      }).Else(() => { cursor.addAssign(1); });
    }).Else(() => { cursor.assign(escape); });
  });
  If(bestTime.lessThanEqual(1), () => {
    const penetration = radius.sub(dot(point.sub(bestAnchor), bestNormal)).max(0);
    point.addAssign(bestNormal.mul(penetration));
    const inward = dot(velocity, bestNormal).min(0);
    velocity.subAssign(bestNormal.mul(inward));
    velocity.mulAssign(friction.oneMinus());
  });
}

/** Recover pre-existing intersections only for certified closed triangle shells.
 * Open concave floors remain two-sided surfaces and never gain a solid volume.
 * a.w carries the field's signed outward winding; zero means an open mesh.
 */
export function projectClothClosedContact({ field, skip, point, velocity, radius, friction }) {
  // Query each certified shell independently: a nearby outside surface on a
  // different object must not hide penetration into this shell.
  Loop({ start: 0, end: field.closedShellCountUniform, name: "clothShell" }, ({ clothShell: shell }) => {
  const bestDistance = float(1e30).toVar(), closest = vec3(0).toVar(), outward = vec3(0).toVar();
  const cursor = int(0).toVar();
  Loop({ start: 0, end: field.countUniform }, () => {
    If(cursor.greaterThanEqual(field.countUniform), () => { Break(); });
    const base = cursor.mul(5), low = field.buffer.element(base), high = field.buffer.element(base.add(1));
    const gap = point.sub(point.clamp(low.xyz, high.xyz));
    const minShell = field.buffer.element(base.add(3)).w.toInt(), maxShell = field.buffer.element(base.add(4)).w.toInt();
    const shellMatches = high.w.greaterThan(.5).select(minShell.equal(shell), minShell.lessThanEqual(shell).and(maxShell.greaterThanEqual(shell)));
    If(shellMatches.and(field.buffer.element(base.add(2)).w.abs().greaterThan(.5)).and(dot(gap, gap).lessThanEqual(bestDistance)), () => {
      If(high.w.greaterThan(.5), () => {
        const ar = field.buffer.element(base.add(2)), br = field.buffer.element(base.add(3)), cr = field.buffer.element(base.add(4));
        If(ar.w.abs().greaterThan(.5).and(cr.w.toInt().notEqual(skip)), () => {
          const a = ar.xyz, b = br.xyz, c = cr.xyz, ab = b.sub(a), ac = c.sub(a);
          const n = ab.cross(ac).normalize().mul(ar.w);
          const projected = point.sub(n.mul(dot(point.sub(a), n)));
          const ap = projected.sub(a), aa = dot(ab, ab), bb = dot(ac, ac), mixed = dot(ab, ac);
          const inverse = aa.mul(bb).sub(mixed.mul(mixed)).max(.000000000001).reciprocal();
          const u = bb.mul(dot(ap, ab)).sub(mixed.mul(dot(ap, ac))).mul(inverse);
          const v = aa.mul(dot(ap, ac)).sub(mixed.mul(dot(ap, ab))).mul(inverse);
          const q = vec3(projected).toVar();
          If(u.lessThan(0).or(v.lessThan(0)).or(u.add(v).greaterThan(1)), () => {
            const edgeDistance = float(1e30).toVar();
            for (const [start, finish] of [[a, b], [b, c], [c, a]]) {
              const edge = finish.sub(start), t = dot(point.sub(start), edge).div(dot(edge, edge).max(.000000001)).clamp(0, 1);
              const candidate = start.add(edge.mul(t)), d = dot(point.sub(candidate), point.sub(candidate));
              If(d.lessThan(edgeDistance), () => { edgeDistance.assign(d); q.assign(candidate); });
            }
          });
          const distance = dot(point.sub(q), point.sub(q));
          If(distance.lessThan(bestDistance.sub(.00000001)), () => {
            bestDistance.assign(distance); closest.assign(q); outward.assign(n);
          }).ElseIf(distance.sub(bestDistance).abs().lessThan(.00000001).and(dot(q.sub(closest), q.sub(closest)).lessThan(.00000001)), () => {
            outward.addAssign(n);
          });
        });
        cursor.assign(low.w.toInt());
      }).Else(() => { cursor.addAssign(1); });
    }).Else(() => { cursor.assign(low.w.toInt()); });
  });
  If(bestDistance.lessThan(1e29).and(outward.length().greaterThan(.000001)), () => {
    const normal = outward.normalize();
    If(dot(point.sub(closest), normal).lessThan(-.000001), () => {
      point.assign(closest.add(normal.mul(radius)));
      velocity.subAssign(normal.mul(dot(velocity, normal).min(0)));
      velocity.mulAssign(friction.oneMinus());
    });
  });
  });
}
