// CPU-only policy and geometry helpers for the four analytic emissive seats.
//
// The light tree is free to describe hundreds of emitters, but the analytic
// shadow path is deliberately fixed at four uniform slots.  These helpers let
// one genuinely extended, sheet-like emissive mesh spend unused or lower-value
// seats on spatial segments without changing that shader contract.

export const MAX_SURFACE_SEAT_TRIANGLES = 200_000;

const len3 = (x, y, z) => Math.hypot(x, y, z);

/** CPU mirror of giLight's transform-stable thin-box shadow target. */
export function sampleThinBoxEmitterSurface({
  center, axes, half, receiver, jitter, thinRatio = 0.2, inset = 0.95,
}) {
  if (!center || !axes || axes.length !== 3 || !half || !receiver || !jitter) return null;
  let normalAxis = 0;
  if (half[1] < half[normalAxis]) normalAxis = 1;
  if (half[2] < half[normalAxis]) normalAxis = 2;
  const maxHalf = Math.max(half[0], half[1], half[2]);
  if (!(maxHalf > 0) || half[normalAxis] > maxHalf * thinRatio) return null;
  const uAxis = (normalAxis + 1) % 3;
  const vAxis = (normalAxis + 2) % 3;
  const n = axes[normalAxis];
  const side = ((receiver[0] - center[0]) * n[0]
    + (receiver[1] - center[1]) * n[1]
    + (receiver[2] - center[2]) * n[2]) >= 0 ? 1 : -1;
  const su = (jitter[0] * 2 - 1) * inset * half[uAxis];
  const sv = (jitter[1] * 2 - 1) * inset * half[vAxis];
  return [0, 1, 2].map((k) => center[k]
    + n[k] * half[normalAxis] * side
    + axes[uAxis][k] * su
    + axes[vAxis][k] * sv);
}

function boundsOf(items) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let weight = 0;
  for (const item of items) {
    const lo = item.localMin;
    const hi = item.localMax;
    for (let k = 0; k < 3; k++) {
      if (lo[k] < min[k]) min[k] = lo[k];
      if (hi[k] > max[k]) max[k] = hi[k];
    }
    weight += item.localArea ?? item.areaFraction ?? 0;
  }
  return { min, max, weight };
}

function widestAxis(bounds) {
  let axis = 0;
  let extent = bounds.max[0] - bounds.min[0];
  for (let k = 1; k < 3; k++) {
    const e = bounds.max[k] - bounds.min[k];
    if (e > extent) { extent = e; axis = k; }
  }
  return { axis, extent };
}

function centreOn(item, axis) {
  return ((item.localMin?.[axis] ?? 0) + (item.localMax?.[axis] ?? 0)) * 0.5;
}

function splitWeighted(items, axis) {
  const ordered = [...items].sort((a, b) =>
    (centreOn(a, axis) - centreOn(b, axis)) || ((a.id ?? 0) - (b.id ?? 0)));
  let total = 0;
  for (const item of ordered) total += item.localArea ?? item.areaFraction ?? 0;
  let prefix = 0;
  let cut = 1;
  let best = Infinity;
  for (let i = 1; i < ordered.length; i++) {
    prefix += ordered[i - 1].localArea ?? ordered[i - 1].areaFraction ?? 0;
    const error = Math.abs(prefix - total * 0.5);
    if (error < best) { best = error; cut = i; }
  }
  return [ordered.slice(0, cut), ordered.slice(cut)];
}

function spatialGroups(items, count) {
  const groups = [[...items]];
  while (groups.length < count) {
    let best = -1;
    let bestScore = -1;
    let bestAxis = 0;
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].length < 2) continue;
      const bounds = boundsOf(groups[i]);
      const widest = widestAxis(bounds);
      const score = widest.extent * Math.sqrt(Math.max(bounds.weight, 1e-12));
      if (score > bestScore) { best = i; bestScore = score; bestAxis = widest.axis; }
    }
    if (best < 0) break;
    const [a, b] = splitWeighted(groups[best], bestAxis);
    if (!a.length || !b.length) break;
    groups.splice(best, 1, a, b);
  }
  return groups;
}

function largestSymmetricEigenvalue(xx, xy, xz, yy, yz, zz) {
  let x = 1;
  let y = 0.73;
  let z = 0.41;
  for (let i = 0; i < 10; i++) {
    const nx = xx * x + xy * y + xz * z;
    const ny = xy * x + yy * y + yz * z;
    const nz = xz * x + yz * y + zz * z;
    const l = len3(nx, ny, nz);
    if (!(l > 1e-20)) return 0;
    x = nx / l; y = ny / l; z = nz / l;
  }
  return x * (xx * x + xy * y + xz * z)
    + y * (xy * x + yy * y + yz * z)
    + z * (xz * x + yz * y + zz * z);
}

/**
 * A cached, local-space spatial partition for an elongated emissive SURFACE.
 *
 * The normal-covariance gate is what keeps a string of tiny spherical bulbs on
 * the existing one-seat consolidation path: a sign/panel has one dominant
 * normal axis, while bulbs and tubes distribute their normals around a volume.
 */
export function emitterSurfaceSeatSource(geometry, options = {}) {
  const position = geometry?.attributes?.position;
  if (!position) return null;
  const index = geometry.index;
  const maxParts = Math.max(2, Math.min(4, Math.floor(options.maxParts ?? 4)));
  const triCount = Math.floor((index ? index.count : position.count) / 3);
  const version = `${position.version ?? position.data?.version ?? 0}/${index?.version ?? index?.data?.version ?? 0}/${triCount}/${maxParts}`;
  const cached = geometry.userData?.__giEmitterSurfaceSeats;
  if (cached?.version === version) return cached.source;
  const store = (source) => {
    (geometry.userData ??= {}).__giEmitterSurfaceSeats = { version, source };
    return source;
  };
  if (triCount < 4 || triCount > MAX_SURFACE_SEAT_TRIANGLES) return store(null);

  const triangles = [];
  let totalArea = 0;
  let xx = 0; let xy = 0; let xz = 0; let yy = 0; let yz = 0; let zz = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const ax = position.getX(i0); const ay = position.getY(i0); const az = position.getZ(i0);
    const bx = position.getX(i1); const by = position.getY(i1); const bz = position.getZ(i1);
    const cx = position.getX(i2); const cy = position.getY(i2); const cz = position.getZ(i2);
    const abx = bx - ax; const aby = by - ay; const abz = bz - az;
    const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const nlen = len3(nx, ny, nz);
    if (!(nlen > 1e-20)) continue;
    const area = nlen * 0.5;
    const ux = nx / nlen; const uy = ny / nlen; const uz = nz / nlen;
    xx += area * ux * ux; xy += area * ux * uy; xz += area * ux * uz;
    yy += area * uy * uy; yz += area * uy * uz; zz += area * uz * uz;
    totalArea += area;
    triangles.push({
      id: t,
      localArea: area,
      localMin: [Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.min(az, bz, cz)],
      localMax: [Math.max(ax, bx, cx), Math.max(ay, by, cy), Math.max(az, bz, cz)],
    });
  }
  if (triangles.length < 4 || !(totalArea > 0)) return store(null);

  const whole = boundsOf(triangles);
  const extents = whole.max.map((v, k) => Math.max(0, v - whole.min[k])).sort((a, b) => a - b);
  const [minor, middle, major] = extents;
  const normalDominance = largestSymmetricEigenvalue(xx, xy, xz, yy, yz, zz) / totalArea;
  // Surface, not volume; long enough to gain placement; not a hair-thin tube.
  if (!(major > 1e-6)
    || minor / major > 0.3
    || major / Math.max(middle, 1e-9) < 2.5
    || middle / major < 0.015
    || normalDominance < 0.65) return store(null);

  const rawGroups = spatialGroups(triangles, maxParts);
  if (rawGroups.length < 2) return store(null);
  const wholeDiag = len3(
    whole.max[0] - whole.min[0], whole.max[1] - whole.min[1], whole.max[2] - whole.min[2],
  );
  let meanDiag = 0;
  const parts = rawGroups.map((group, id) => {
    const bounds = boundsOf(group);
    const diag = len3(
      bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2],
    );
    meanDiag += bounds.weight * diag;
    return {
      id,
      localMin: bounds.min,
      localMax: bounds.max,
      localArea: bounds.weight,
      areaFraction: bounds.weight / totalArea,
    };
  });
  // A two-triangle quad (or other huge crossing triangles) cannot actually be
  // localised by a triangle partition. Refuse it; its existing OBB is exact.
  if (!(meanDiag / totalArea < wholeDiag * 0.8)) return store(null);
  return store({
    parts,
    localArea: totalArea,
    extent: major,
    normalDominance,
  });
}

/** Groups every atomic surface part exactly once into `count` seat shapes. */
export function emitterSurfaceSeatGroups(source, count) {
  if (!source?.parts?.length) return [];
  const groups = spatialGroups(source.parts, Math.max(1, Math.min(count, source.parts.length)));
  return groups.map((members, id) => {
    const bounds = boundsOf(members);
    return {
      id,
      partIds: members.map((p) => p.id).sort((a, b) => a - b),
      localMin: bounds.min,
      localMax: bounds.max,
      areaFraction: members.reduce((sum, p) => sum + p.areaFraction, 0),
    };
  });
}

/**
 * Spend analytic slots on extended surfaces. Empty slots are used first. Once
 * the four-seat budget is full, a surface's next power-balanced segment may
 * replace the weakest distinct seat when its own per-segment score is higher.
 * The displaced mesh is not deleted: the light tree/palette keeps delivering
 * it; only the scarce analytic shadow bonus moves. This never increases shader
 * capacity.
 */
export function allocateEmitterSurfaceSeats(selected, options = {}) {
  const capacity = Math.max(0, Math.floor(options.capacity ?? 4));
  const sourceOf = options.sourceOf ?? (() => null);
  const scoreOf = options.scoreOf ?? (() => 0);
  const unique = [];
  const seen = new Set();
  for (const cand of selected ?? []) {
    if (!cand?.mesh || seen.has(cand.mesh)) continue;
    seen.add(cand.mesh);
    unique.push(cand);
  }
  const counts = new Map(unique.map((cand) => [cand.mesh, 1]));
  let remaining = Math.max(0, capacity - unique.length);
  const cap = unique.length === 1 ? capacity : 2;
  const marginalScore = (cand, nextCount) =>
    Math.max(0, scoreOf(cand)) / Math.max(1, nextCount);
  while (remaining > 0) {
    let best = null;
    let bestPriority = -Infinity;
    for (const cand of unique) {
      const source = sourceOf(cand.mesh);
      const count = counts.get(cand.mesh) ?? 1;
      if (!source || count >= cap || count >= source.parts.length) continue;
      const priority = marginalScore(cand, count + 1);
      if (priority > bestPriority) { best = cand; bestPriority = priority; }
    }
    if (!best) break;
    counts.set(best.mesh, (counts.get(best.mesh) ?? 1) + 1);
    remaining--;
  }
  // A full Bistro-class scene has no holes. Let a genuinely useful second
  // segment compete with the weakest first seat on the same quantity the base
  // chooser uses (power, or apparent power in the legacy camera-follow arm).
  // 1.05 is enough hysteresis to keep near-ties deterministic without making a
  // long sign require an arbitrary 1.5x energy surplus merely to retain its
  // authored spatial support.
  const retained = new Set(unique);
  if (unique.length >= capacity && capacity > 0) {
    while (true) {
      let challenger = null;
      let challengerScore = -Infinity;
      for (const cand of unique) {
        if (!retained.has(cand)) continue;
        const source = sourceOf(cand.mesh);
        const count = counts.get(cand.mesh) ?? 1;
        if (!source || count >= cap || count >= source.parts.length) continue;
        const score = marginalScore(cand, count + 1);
        if (score > challengerScore) { challenger = cand; challengerScore = score; }
      }
      if (!challenger) break;
      let victim = null;
      let victimScore = Infinity;
      for (const cand of unique) {
        if (!retained.has(cand) || cand === challenger) continue;
        // Never remove the only seat from a mesh already split across seats;
        // decrementing such a plan would require rebuilding all group ids.
        if ((counts.get(cand.mesh) ?? 1) !== 1) continue;
        const score = Math.max(0, scoreOf(cand));
        if (score < victimScore) { victim = cand; victimScore = score; }
      }
      if (!victim || !(challengerScore > victimScore * 1.05)) break;
      retained.delete(victim);
      counts.delete(victim.mesh);
      counts.set(challenger.mesh, (counts.get(challenger.mesh) ?? 1) + 1);
    }
  }
  // Maps are used by the hot integration path; carrying the retained ordered
  // candidates on the same result avoids a second policy pass and preserves the
  // public Map surface used by the CPU tests.
  counts.selectedCandidates = unique.filter((cand) => retained.has(cand));
  return counts;
}
