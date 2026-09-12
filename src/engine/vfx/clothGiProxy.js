// ── A MESH CLOTH'S GI PROXY LATTICE ─────────────────────────────────────────
//
// GI sees a cloth as a 128-triangle proxy refitted on the GPU every frame from
// the live solver positions (`gi/gpuGridBvh.js`). That proxy is an 8x8 grid of
// quads, and a PLANE cloth hands it its own lattice: corner (x, y) is simply
// vertex `(x·(n−1)+4)/8` of the n×n sheet.
//
// ⭐ A MESH CLOTH HAS NO LATTICE, AND UNTIL NOW THAT MEANT NO GI AT ALL.
//
// `clothArena.createClothMember` set `userData.giGpuGrid` only on the plane
// path, so an authored curtain got none — and the two OTHER doors into GI are
// both shut for a cloth by design: `GISystem#collectMeshes` skips the source
// mesh (`userData.clothHidden`, because its CPU vertices stay at the rest pose
// for picking) and skips the cloth mesh itself (`userData.vfxSimulation`, for
// the same reason). So a modelled curtain was invisible to global illumination
// in every respect: it cast no traced shadow, occluded no bounce, and — the
// report this file was written for (user, 2026-09-11) — bled NO COLOUR. Turn
// the Cloth component off and the very same curtain threw red and green across
// Sponza's floor; turn it on and the floor went neutral.
//
// The fix is to give the mesh a lattice it never had: sample a 9×9 grid of its
// REST vertices and hand those 81 indices to the same proxy builder. The GPU
// side is then identical for both kinds of cloth — one shader, one pipeline,
// one code path — which is the only reason this is a table of indices rather
// than a second WGSL kernel written around arbitrary topology.
//
// ── WHY THE SAMPLING FRAME IS NOT UV AND NOT THE BOUNDING BOX ───────────────
//
// The lattice needs a 2D parameterisation of the sheet to sample on. Three
// candidates, and two of them fail on exactly the meshes this feature is for:
//
//   · UV — an imported curtain's UVs are an ATLAS layout, not a sheet
//     parameterisation. Sponza's are packed with other props; a lattice walked
//     across them samples whatever else shares the chart.
//   · THE AXIS-ALIGNED BOX — `clothMeshTopology.principalExtents` already
//     records why this ruler is wrong: a sail is thin along its OWN normal,
//     which is almost never a world axis, so a sheet rotated 45° reads as a
//     solid and its two "largest" box axes are two diagonals of one face.
//   · THE SHEET'S OWN PLANE — the covariance's smallest eigenvector is the
//     normal whatever the orientation, and the rotation WITHIN that plane is
//     then chosen by the tightest bounding box (see `inPlaneFrame`).
//
// Rest pose, not live positions: the table is built once at attach and must
// stay valid while the cloth swings. A curtain's parameterisation does not
// change when it billows — only the positions the table points at do, and
// those are re-read on the GPU every frame.

/** The proxy is 8×8 quads, so its corner lattice is 9×9. Must match `gpuGridBvh`. */
export const CLOTH_GI_PROXY_SPAN = 8;
export const CLOTH_GI_PROXY_CORNERS = (CLOTH_GI_PROXY_SPAN + 1) ** 2;

/**
 * Eigenvalues of a symmetric 3×3, largest first. Closed form (Smith 1961) —
 * the same one `clothMeshTopology.principalExtents` uses for the thinness
 * test, kept as VARIANCES here because the eigenvector formula below needs
 * them unscaled.
 *
 * @param {number[]} c upper triangle [xx, xy, xz, yy, yz, zz]
 */
function eigenvalues3(c) {
  const [xx, xy, xz, yy, yz, zz] = c;
  const q = (xx + yy + zz) / 3;
  const ax = xx - q, ay = yy - q, az = zz - q;
  const p2 = (ax * ax + ay * ay + az * az) / 6 + (xy * xy + xz * xz + yz * yz) / 3;
  const p = Math.sqrt(Math.max(p2, 0));
  if (p < 1e-20) return [q, q, q]; // isotropic: no thin axis at all
  const bx = ax / p, by = ay / p, bz = az / p;
  const bxy = xy / p, bxz = xz / p, byz = yz / p;
  const det = bx * (by * bz - byz * byz) - bxy * (bxy * bz - byz * bxz) + bxz * (bxy * byz - by * bxz);
  const phi = Math.acos(Math.min(1, Math.max(-1, det / 2))) / 3;
  const e0 = q + 2 * p * Math.cos(phi);
  const e2 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  // The trace is invariant, so the middle one comes free and cannot drift.
  return [e0, xx + yy + zz - e0 - e2, e2];
}

/**
 * The eigenvector for the eigenvalue of a symmetric 3×3 that is NOT `a` or `b`.
 *
 * ⛔ NOT POWER ITERATION, which is where the first draft of this file went
 * wrong. Iterating separates two eigenvalues at the RATIO between them, and
 * both shapes this has to handle are worst cases: a SQUARE sheet has a
 * two-fold in-plane eigenvalue (ratio 1 — it never separates and lands on
 * whichever diagonal the seed leaned toward) and a LONG THIN strip has a ratio
 * near 1 for the other pair. A diagonal frame is not a wrong answer about the
 * covariance, but it is a wrong LATTICE: the sheet becomes a DIAMOND inside
 * the sampling square, so the four corner cells hold no vertices at all and
 * the proxy folds flat exactly where a curtain's corners are.
 *
 * The closed form has no such failure. For distinct eigenvalues every column
 * of (C − aI)(C − bI) is parallel to the remaining eigenvector, so the longest
 * column IS the answer, exactly and in fixed time. (A and B are polynomials in
 * C, so they commute and the product is symmetric; the choice of column is
 * only ever about magnitude.) Fully degenerate input makes every column
 * vanish, which is reported as null rather than as a direction nobody computed.
 */
function eigenvector3(c, a, b) {
  const [xx, xy, xz, yy, yz, zz] = c;
  const A = [xx - a, xy, xz, xy, yy - a, yz, xz, yz, zz - a];
  const B = [xx - b, xy, xz, xy, yy - b, yz, xz, yz, zz - b];
  let best = null, bestLength = 0;
  for (let col = 0; col < 3; col++) {
    const v = [
      A[0] * B[col] + A[1] * B[col + 3] + A[2] * B[col + 6],
      A[3] * B[col] + A[4] * B[col + 3] + A[5] * B[col + 6],
      A[6] * B[col] + A[7] * B[col + 3] + A[8] * B[col + 6],
    ];
    const length = Math.hypot(v[0], v[1], v[2]);
    if (length > bestLength) { bestLength = length; best = v; }
  }
  if (!(bestLength > 1e-24)) return null;
  return [best[0] / bestLength, best[1] / bestLength, best[2] / bestLength];
}

/** A quarter turn is enough — a bounding box repeats every 90°. */
const FRAME_STEPS = 64;
/** The angle scan is O(steps × vertices); a 20k-vertex curtain is subsampled. */
const FRAME_SAMPLES = 4096;

/**
 * The two in-plane axes, chosen as the frame whose bounding box is SMALLEST.
 *
 * The normal is well determined — it is the one axis a sheet genuinely has —
 * but the rotation within the plane is not, and the covariance has no opinion
 * at all about a square one. So this asks the question the lattice actually
 * cares about, "which frame wraps this sheet tightest", whose answer for a
 * rectangle is its own edges and for a curtain is the direction it hangs.
 */
function inPlaneFrame(positions, n, centre, normal) {
  // Any orthonormal pair in the plane; the scan below fixes the rotation.
  const axis = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const cross = [
    normal[1] * axis[2] - normal[2] * axis[1],
    normal[2] * axis[0] - normal[0] * axis[2],
    normal[0] * axis[1] - normal[1] * axis[0],
  ];
  const crossLength = Math.hypot(cross[0], cross[1], cross[2]);
  if (!(crossLength > 1e-12)) return null;
  const e1 = [cross[0] / crossLength, cross[1] / crossLength, cross[2] / crossLength];
  const e2 = [
    normal[1] * e1[2] - normal[2] * e1[1],
    normal[2] * e1[0] - normal[0] * e1[2],
    normal[0] * e1[1] - normal[1] * e1[0],
  ];
  const stride = Math.max(1, Math.floor(n / FRAME_SAMPLES));
  let bestArea = Infinity, bestAngle = 0;
  for (let step = 0; step < FRAME_STEPS; step++) {
    const angle = (step / FRAME_STEPS) * (Math.PI / 2);
    const ca = Math.cos(angle), sa = Math.sin(angle);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < n; i += stride) {
      const dx = positions[i * 3] - centre[0], dy = positions[i * 3 + 1] - centre[1], dz = positions[i * 3 + 2] - centre[2];
      const p1 = dx * e1[0] + dy * e1[1] + dz * e1[2];
      const p2 = dx * e2[0] + dy * e2[1] + dz * e2[2];
      const pu = p1 * ca + p2 * sa, pv = p2 * ca - p1 * sa;
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) { bestArea = area; bestAngle = angle; }
  }
  const ca = Math.cos(bestAngle), sa = Math.sin(bestAngle);
  return [
    [e1[0] * ca + e2[0] * sa, e1[1] * ca + e2[1] * sa, e1[2] * ca + e2[2] * sa],
    [e2[0] * ca - e1[0] * sa, e2[1] * ca - e1[1] * sa, e2[2] * ca - e1[2] * sa],
  ];
}

/**
 * The 81 vertex indices of a mesh cloth's GI proxy lattice, or null when the
 * geometry is too small or too degenerate to decimate.
 *
 * @param {ArrayLike<number>} positions  rest positions, xyz-interleaved
 * @param {number} [count]               vertex count (defaults to all of them)
 * @returns {?Uint32Array}               CLOTH_GI_PROXY_CORNERS indices, row-major
 */
export function clothGiProxyCorners(positions, count = (positions?.length ?? 0) / 3) {
  const n = Math.min(Math.floor(count), Math.floor((positions?.length ?? 0) / 3));
  // Fewer vertices than lattice corners is not a failure to report — it is a
  // cloth so coarse that its own triangles ARE the proxy, and there is nothing
  // cheaper to fall back to. Refusing leaves it on the pre-existing "no GI"
  // path rather than seating a proxy that repeats one vertex 81 times and
  // traces as a point.
  if (!(n >= CLOTH_GI_PROXY_CORNERS)) return null;

  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += positions[i * 3]; cy += positions[i * 3 + 1]; cz += positions[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;

  // Upper triangle of the covariance: [xx, xy, xz, yy, yz, zz].
  const c = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - cx, dy = positions[i * 3 + 1] - cy, dz = positions[i * 3 + 2] - cz;
    c[0] += dx * dx; c[1] += dx * dy; c[2] += dx * dz;
    c[3] += dy * dy; c[4] += dy * dz; c[5] += dz * dz;
  }
  for (let i = 0; i < 6; i++) c[i] /= n;

  const [big, mid] = eigenvalues3(c);
  // Two axes with real extent, or there is no plane to lay a lattice on — a
  // point cloud and a wire both land here. (`analyseClothMesh` has already
  // refused the SOLID ones; this is the same wall, one system further down.)
  if (!(big > 1e-18) || !(mid > big * 1e-6)) return null;
  const normal = eigenvector3(c, big, mid);
  if (!normal) return null;
  const frame = inPlaneFrame(positions, n, [cx, cy, cz], normal);
  if (!frame) return null;
  const [u, v] = frame;

  // Project once, keep the coordinates: the assignment pass below reads them
  // a second time and a 20k-vertex cloth should not project twice.
  const su = new Float32Array(n), sv = new Float32Array(n);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - cx, dy = positions[i * 3 + 1] - cy, dz = positions[i * 3 + 2] - cz;
    const pu = dx * u[0] + dy * u[1] + dz * u[2];
    const pv = dx * v[0] + dy * v[1] + dz * v[2];
    su[i] = pu; sv[i] = pv;
    if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
    if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
  }
  const spanU = maxU - minU, spanV = maxV - minV;
  if (!(spanU > 1e-9) || !(spanV > 1e-9)) return null;

  // ── ONE PASS OVER THE VERTICES, NOT 81 ────────────────────────────────────
  //
  // The obvious construction — for each of the 81 corners, scan every vertex —
  // is 81·N and runs inside `vfx:attach`, which is on the freeze ledger. This
  // inverts it: each vertex proposes itself to the ONE corner it is nearest,
  // and each corner keeps its closest proposal. O(N + 81), and wherever the
  // sheet actually covers the lattice the answer is identical.
  const side = CLOTH_GI_PROXY_SPAN + 1;
  const best = new Float64Array(CLOTH_GI_PROXY_CORNERS).fill(Infinity);
  const pick = new Int32Array(CLOTH_GI_PROXY_CORNERS).fill(-1);
  for (let i = 0; i < n; i++) {
    const gu = ((su[i] - minU) / spanU) * CLOTH_GI_PROXY_SPAN;
    const gv = ((sv[i] - minV) / spanV) * CLOTH_GI_PROXY_SPAN;
    const x = Math.min(CLOTH_GI_PROXY_SPAN, Math.max(0, Math.round(gu)));
    const y = Math.min(CLOTH_GI_PROXY_SPAN, Math.max(0, Math.round(gv)));
    const k = y * side + x;
    const distance = (gu - x) ** 2 + (gv - y) ** 2;
    if (distance < best[k]) { best[k] = distance; pick[k] = i; }
  }

  // A cloth with a HOLE in it (or an L-shaped sail) leaves lattice corners
  // with no vertex nearest to them. Those must not stay unset: index 0 for an
  // unfilled corner drags one quad of the proxy to whatever vertex 0 happens
  // to be, which traces as a spike across the room. Flood the gaps from their
  // filled neighbours instead — the proxy then folds flat there, which is the
  // honest answer for a region the sheet does not occupy.
  const corners = new Uint32Array(CLOTH_GI_PROXY_CORNERS);
  const queue = [];
  for (let k = 0; k < CLOTH_GI_PROXY_CORNERS; k++) {
    if (pick[k] >= 0) { corners[k] = pick[k]; queue.push(k); }
  }
  if (queue.length === 0) return null;
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head], x = k % side, y = (k / side) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= side || ny >= side) continue;
      const j = ny * side + nx;
      if (pick[j] >= 0) continue;
      pick[j] = pick[k]; corners[j] = corners[k]; queue.push(j);
    }
  }
  return corners;
}
