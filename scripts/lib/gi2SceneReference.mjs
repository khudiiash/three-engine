// GI2 — A **TRIANGLE** PATH-TRACED REFERENCE, FOR THE PER-PIXEL CORNELL GATE.
//
// ══ WHY A SECOND REFERENCE NEXT TO `gi2Reference.mjs` ════════════════════════
//
// `gi2Reference.mjs` traces the harness rig's ANALYTIC primitive list — boxes,
// one sphere, one panel — because that rig is built by `windowFill.js` out of
// exactly those primitives and the reference must receive the same description
// the GPU received. It cannot trace the user's own scene: there is no primitive
// list there, only meshes.
//
// This one takes the scene as TRIANGLES + a per-triangle material index, which
// is the one description every arm can produce: the user's `Cornel.scene` (read
// out of `giSystem.state.entries`, i.e. exactly the meshes GI participates in,
// with exactly the albedo/emissive the GI resolver assigned them) AND the
// harness rig's boxes (tessellated on the way in). One tracer, two scenes,
// no third description of the truth to drift.
//
// ══ WHAT IT COMPUTES, AND IN WHICH UNITS ═════════════════════════════════════
//
// `irradiance(p, n, spp, seed)` → `E`, the incident irradiance at a surface
// point, i.e. **exactly what `gi2.textures.irradiance` holds** (`indirect`
// before the `/π` a diffuse BRDF applies). Same contract as
// `gi2Reference.irradiance`, so the two references are directly comparable and
// the old 8-crop Cornell parity keeps its meaning.
//
//   E(p,n) = ∫ L_i(ω) cosθ dω
//          = E_direct(p,n)            ← NEXT-EVENT over the emissive triangles
//          + (π/N) Σ_k Lo(hit_k)      ← cosine-sampled indirect, emission
//                                       REMOVED at every hit (NEE owns it)
//
// ⭐ NEE PLUS AN EMISSION-FREE COSINE BOUNCE IS NOT AN OPTIMISATION HERE, IT IS
// WHAT MAKES THE REFERENCE'S OWN NOISE SMALL ENOUGH TO GATE A BLOTCH METRIC.
// A naive cosine-only estimator on a Cornell box needs ~10⁴ spp before its own
// per-pixel σ drops under 2 %, and a reference whose noise is the same order as
// the artefact cannot certify anything about the artefact.
// [[probe-blind-statistics]]: the instrument's floor is reported, per pixel,
// and the gate refuses to score any pixel whose reference is noisier than the
// threshold it is about to apply.
//
// ⚠ THE REFERENCE TRACES TRIANGLES, GI2 TRACES VOXELS. Their disagreement
// therefore CONTAINS the voxelization error, deliberately: a Cornell box at
// v0 ≈ 0.16 m has walls 0.1 m thick, and "the wall is one voxel and the box's
// dark side shares it" is a real GI2 fault that a voxel-space reference would
// define out of existence. The per-surface energy ratio is what exposes it.

const EPS = 1e-4;

/** Deterministic, cheap, and the same generator every other §19 probe uses. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * A flat BVH over a packed triangle soup. Median split on the widest axis of
 * the centroid box; leaves of ≤ 4 triangles. Cornell is ~100 triangles and the
 * harness rig fewer, so the build is microseconds and the traversal is what
 * matters — hence the flat `Int32Array` layout and a manual stack.
 *
 * Node layout, 8 ints per node:
 *   0..2  min xyz (as float bits in a parallel Float32Array)
 *   3..5  max xyz
 *   6     left child (interior) or first triangle (leaf, negated - 1)
 *   7     right child (interior) or triangle count (leaf)
 */
function buildBvh(tris, count) {
  const idx = new Int32Array(count);
  for (let i = 0; i < count; i++) idx[i] = i;
  const cx = new Float32Array(count);
  const cy = new Float32Array(count);
  const cz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const b = i * 9;
    cx[i] = (tris[b] + tris[b + 3] + tris[b + 6]) / 3;
    cy[i] = (tris[b + 1] + tris[b + 4] + tris[b + 7]) / 3;
    cz[i] = (tris[b + 2] + tris[b + 5] + tris[b + 8]) / 3;
  }
  const maxNodes = Math.max(1, count * 2);
  const bmin = new Float32Array(maxNodes * 3);
  const bmax = new Float32Array(maxNodes * 3);
  const link = new Int32Array(maxNodes * 2);
  let nodes = 0;

  const build = (start, end) => {
    const node = nodes++;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = start; i < end; i++) {
      const b = idx[i] * 9;
      for (let v = 0; v < 3; v++) {
        const px = tris[b + v * 3], py = tris[b + v * 3 + 1], pz = tris[b + v * 3 + 2];
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
      }
    }
    bmin[node * 3] = x0; bmin[node * 3 + 1] = y0; bmin[node * 3 + 2] = z0;
    bmax[node * 3] = x1; bmax[node * 3 + 1] = y1; bmax[node * 3 + 2] = z1;
    const n = end - start;
    if (n <= 4) {
      link[node * 2] = -(start + 1);
      link[node * 2 + 1] = n;
      return node;
    }
    // Widest CENTROID axis, split at the median (a nth_element by sort — n is
    // in the hundreds, so the O(n log n) is free and the code is one line).
    let mx0 = Infinity, my0 = Infinity, mz0 = Infinity, mx1 = -Infinity, my1 = -Infinity, mz1 = -Infinity;
    for (let i = start; i < end; i++) {
      const t = idx[i];
      if (cx[t] < mx0) mx0 = cx[t]; if (cx[t] > mx1) mx1 = cx[t];
      if (cy[t] < my0) my0 = cy[t]; if (cy[t] > my1) my1 = cy[t];
      if (cz[t] < mz0) mz0 = cz[t]; if (cz[t] > mz1) mz1 = cz[t];
    }
    const ex = mx1 - mx0, ey = my1 - my0, ez = mz1 - mz0;
    const axis = ex >= ey && ex >= ez ? cx : (ey >= ez ? cy : cz);
    const slice = Array.from(idx.subarray(start, end)).sort((a, b) => axis[a] - axis[b]);
    idx.set(slice, start);
    const mid = (start + end) >> 1;
    link[node * 2] = build(start, mid);
    link[node * 2 + 1] = build(mid, end);
    return node;
  };
  if (count > 0) build(0, count);
  return { bmin, bmax, link, idx, nodes };
}

/**
 * @param {object} scene
 * @param {Float32Array} scene.tris    `count * 9` world-space vertices
 * @param {Int32Array}   scene.triMat  material index per triangle
 * @param {Array<{albedo:number[], emissive:number[]}>} scene.mats
 * @param {number[]} [scene.sky]       radiance of a ray that leaves the scene
 * @param {number}   [bounces]         path depth (direct + `bounces-1` indirect)
 */
export function makeSceneTracer(scene, bounces = 4) {
  const tris = scene.tris;
  const triMat = scene.triMat;
  const mats = scene.mats;
  const sky = scene.sky ?? [0, 0, 0];
  const count = triMat.length;
  const bvh = buildBvh(tris, count);
  const { bmin, bmax, link, idx } = bvh;

  // Precomputed edges + geometric normals: the traversal is the hot loop and
  // recomputing `p1-p0` per test costs ~15 % of the whole trace.
  const e1 = new Float32Array(count * 3);
  const e2 = new Float32Array(count * 3);
  const gn = new Float32Array(count * 3);
  const area = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const b = i * 9;
    const ax = tris[b + 3] - tris[b], ay = tris[b + 4] - tris[b + 1], az = tris[b + 5] - tris[b + 2];
    const bx = tris[b + 6] - tris[b], by = tris[b + 7] - tris[b + 1], bz = tris[b + 8] - tris[b + 2];
    e1[i * 3] = ax; e1[i * 3 + 1] = ay; e1[i * 3 + 2] = az;
    e2[i * 3] = bx; e2[i * 3 + 1] = by; e2[i * 3 + 2] = bz;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    gn[i * 3] = nx / l; gn[i * 3 + 1] = ny / l; gn[i * 3 + 2] = nz / l;
    area[i] = l / 2;
  }

  // ── the emitters, as an area CDF ───────────────────────────────────────────
  const emitTris = [];
  let emitArea = 0;
  for (let i = 0; i < count; i++) {
    const m = mats[triMat[i]];
    if (m && lum(m.emissive) > 1e-6 && area[i] > 1e-9) { emitTris.push(i); emitArea += area[i]; }
  }
  const emitCdf = new Float64Array(emitTris.length);
  {
    let acc = 0;
    for (let k = 0; k < emitTris.length; k++) { acc += area[emitTris[k]]; emitCdf[k] = acc / emitArea; }
  }

  const stack = new Int32Array(64);

  /** Nearest hit. Returns the triangle index or -1; `hitT` carries the distance. */
  let hitT = 0;
  const intersect = (ox, oy, oz, dx, dy, dz, tMax) => {
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    let best = -1;
    let bt = tMax;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const n3 = node * 3;
      let t0 = (bmin[n3] - ox) * ix, t1 = (bmax[n3] - ox) * ix;
      if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
      let u0 = (bmin[n3 + 1] - oy) * iy, u1 = (bmax[n3 + 1] - oy) * iy;
      if (u0 > u1) { const s = u0; u0 = u1; u1 = s; }
      if (u0 > t0) t0 = u0; if (u1 < t1) t1 = u1;
      let v0 = (bmin[n3 + 2] - oz) * iz, v1 = (bmax[n3 + 2] - oz) * iz;
      if (v0 > v1) { const s = v0; v0 = v1; v1 = s; }
      if (v0 > t0) t0 = v0; if (v1 < t1) t1 = v1;
      if (!(t1 >= Math.max(t0, EPS)) || t0 >= bt) continue;
      const l = link[node * 2];
      if (l < 0) {
        const start = -l - 1;
        const n = link[node * 2 + 1];
        for (let k = 0; k < n; k++) {
          const i = idx[start + k];
          const i3 = i * 3;
          const px = dy * e2[i3 + 2] - dz * e2[i3 + 1];
          const py = dz * e2[i3] - dx * e2[i3 + 2];
          const pz = dx * e2[i3 + 1] - dy * e2[i3];
          const det = e1[i3] * px + e1[i3 + 1] * py + e1[i3 + 2] * pz;
          if (det > -1e-12 && det < 1e-12) continue;
          const inv = 1 / det;
          const b = i * 9;
          const tx = ox - tris[b], ty = oy - tris[b + 1], tz = oz - tris[b + 2];
          const u = (tx * px + ty * py + tz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = ty * e1[i3 + 2] - tz * e1[i3 + 1];
          const qy = tz * e1[i3] - tx * e1[i3 + 2];
          const qz = tx * e1[i3 + 1] - ty * e1[i3];
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2[i3] * qx + e2[i3 + 1] * qy + e2[i3 + 2] * qz) * inv;
          if (t > EPS && t < bt) { bt = t; best = i; }
        }
      } else {
        stack[sp++] = l;
        stack[sp++] = link[node * 2 + 1];
      }
    }
    hitT = bt;
    return best;
  };

  const occluded = (ox, oy, oz, dx, dy, dz, tMax) =>
    intersect(ox, oy, oz, dx, dy, dz, tMax) >= 0;

  /**
   * Direct irradiance from the emissive triangles by next-event estimation.
   * `ns` samples, stratified over the area CDF so a multi-face emitter is
   * covered rather than sampled.
   */
  const neeE = (px, py, pz, nx, ny, nz, ns, rnd, out) => {
    out[0] = 0; out[1] = 0; out[2] = 0;
    if (emitTris.length === 0 || emitArea <= 0) return;
    for (let s = 0; s < ns; s++) {
      // stratified over [0,1) — the CDF turns that into "cover every face"
      const xi = (s + rnd()) / ns;
      let lo = 0, hi = emitCdf.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (emitCdf[mid] < xi) lo = mid + 1; else hi = mid; }
      const ti = emitTris[lo];
      const r1 = rnd(), r2 = rnd();
      const su = Math.sqrt(r1);
      // (u,v) → (1−√u, √u·v). |Jacobian| = ½, constant, so this is uniform over
      // the triangle — the standard warp, written for the `A + a·e1 + b·e2`
      // parameterisation the edges above are already in.
      const bu = 1 - su, bv = r2 * su;
      const b = ti * 9, i3 = ti * 3;
      const qx = tris[b] + e1[i3] * bu + e2[i3] * bv;
      const qy = tris[b + 1] + e1[i3 + 1] * bu + e2[i3 + 1] * bv;
      const qz = tris[b + 2] + e1[i3 + 2] * bu + e2[i3 + 2] * bv;
      let wx = qx - px, wy = qy - py, wz = qz - pz;
      const d2 = Math.max(1e-6, wx * wx + wy * wy + wz * wz);
      const d = Math.sqrt(d2);
      wx /= d; wy /= d; wz /= d;
      const cosX = nx * wx + ny * wy + nz * wz;
      if (cosX <= 0) continue;
      // The emitter is a closed body: only the face turned toward `p` emits at
      // it, so the cosine is ONE-SIDED. Averaging |cos| would light a point
      // through the emitter's own back face.
      const cosE = -(gn[i3] * wx + gn[i3 + 1] * wy + gn[i3 + 2] * wz);
      if (cosE <= 0) continue;
      if (occluded(px + nx * EPS * 10, py + ny * EPS * 10, pz + nz * EPS * 10,
        wx, wy, wz, d - 1e-3)) continue;
      const em = mats[triMat[ti]].emissive;
      const w = (cosX * cosE * emitArea) / (d2 * ns);
      out[0] += em[0] * w; out[1] += em[1] * w; out[2] += em[2] * w;
    }
  };

  const tmpE = [0, 0, 0];
  const scratch = Array.from({ length: 12 }, () => [0, 0, 0]);

  /** Outgoing radiance at a surface point, EMISSION EXCLUDED (NEE owns it). */
  const Lo = (px, py, pz, nx, ny, nz, mat, depth, rnd, out) => {
    out[0] = 0; out[1] = 0; out[2] = 0;
    if (depth >= bounces) return;
    const alb = mats[mat]?.albedo ?? [0, 0, 0];
    if (alb[0] + alb[1] + alb[2] <= 0) return;
    const e = scratch[depth * 2];
    neeE(px, py, pz, nx, ny, nz, depth === 0 ? 4 : 1, rnd, e);
    // one cosine-sampled indirect ray
    const sgn = nz >= 0 ? 1 : -1;
    const a0 = -1 / (sgn + nz);
    const b0 = nx * ny * a0;
    const t1x = 1 + sgn * nx * nx * a0, t1y = sgn * b0, t1z = -sgn * nx;
    const t2x = b0, t2y = sgn + ny * ny * a0, t2z = -ny;
    const r1 = rnd(), r2 = rnd();
    const rr = Math.sqrt(r1), phi = 2 * Math.PI * r2;
    const cz2 = Math.sqrt(Math.max(0, 1 - r1));
    let dx = t1x * (rr * Math.cos(phi)) + t2x * (rr * Math.sin(phi)) + nx * cz2;
    let dy = t1y * (rr * Math.cos(phi)) + t2y * (rr * Math.sin(phi)) + ny * cz2;
    let dz = t1z * (rr * Math.cos(phi)) + t2z * (rr * Math.sin(phi)) + nz * cz2;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const ox = px + nx * EPS * 20, oy = py + ny * EPS * 20, oz = pz + nz * EPS * 20;
    const h = intersect(ox, oy, oz, dx, dy, dz, 1e6);
    if (h < 0) {
      e[0] += Math.PI * sky[0]; e[1] += Math.PI * sky[1]; e[2] += Math.PI * sky[2];
    } else {
      const hx = ox + dx * hitT, hy = oy + dy * hitT, hz = oz + dz * hitT;
      const i3 = h * 3;
      let hnx = gn[i3], hny = gn[i3 + 1], hnz = gn[i3 + 2];
      if (hnx * dx + hny * dy + hnz * dz > 0) { hnx = -hnx; hny = -hny; hnz = -hnz; }
      const sub = scratch[depth * 2 + 1];
      Lo(hx, hy, hz, hnx, hny, hnz, triMat[h], depth + 1, rnd, sub);
      e[0] += Math.PI * sub[0]; e[1] += Math.PI * sub[1]; e[2] += Math.PI * sub[2];
    }
    out[0] = (alb[0] / Math.PI) * e[0];
    out[1] = (alb[1] / Math.PI) * e[1];
    out[2] = (alb[2] / Math.PI) * e[2];
  };

  /**
   * Incident irradiance at `(p, n)` — the quantity `gi2.textures.irradiance`
   * holds. Returns `[r, g, b]`.
   *
   * The cosine samples are 2-D STRATIFIED over a √N × √N grid, jittered inside
   * each cell from `seed`: a plain i.i.d. estimator needs ~4× the samples for
   * the same variance on a Cornell box, and this reference is scored on its own
   * noise floor.
   */
  const irradiance = (p, n, spp, seed, neeSamples = 64) => {
    const rnd = mulberry32(seed >>> 0);
    const [px, py, pz] = p;
    let [nx, ny, nz] = n;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const E = [0, 0, 0];
    neeE(px, py, pz, nx, ny, nz, neeSamples, rnd, tmpE);
    E[0] += tmpE[0]; E[1] += tmpE[1]; E[2] += tmpE[2];

    const side = Math.max(1, Math.round(Math.sqrt(spp)));
    const N = side * side;
    const sgn = nz >= 0 ? 1 : -1;
    const a0 = -1 / (sgn + nz);
    const b0 = nx * ny * a0;
    const t1x = 1 + sgn * nx * nx * a0, t1y = sgn * b0, t1z = -sgn * nx;
    const t2x = b0, t2y = sgn + ny * ny * a0, t2z = -ny;
    const ox = px + nx * EPS * 20, oy = py + ny * EPS * 20, oz = pz + nz * EPS * 20;
    const acc = [0, 0, 0];
    const sub = [0, 0, 0];
    for (let sy = 0; sy < side; sy++) {
      for (let sx = 0; sx < side; sx++) {
        const r1 = (sx + rnd()) / side;
        const r2 = (sy + rnd()) / side;
        const rr = Math.sqrt(r1), phi = 2 * Math.PI * r2;
        const cz2 = Math.sqrt(Math.max(0, 1 - r1));
        let dx = t1x * (rr * Math.cos(phi)) + t2x * (rr * Math.sin(phi)) + nx * cz2;
        let dy = t1y * (rr * Math.cos(phi)) + t2y * (rr * Math.sin(phi)) + ny * cz2;
        let dz = t1z * (rr * Math.cos(phi)) + t2z * (rr * Math.sin(phi)) + nz * cz2;
        const dl = Math.hypot(dx, dy, dz) || 1;
        dx /= dl; dy /= dl; dz /= dl;
        const h = intersect(ox, oy, oz, dx, dy, dz, 1e6);
        if (h < 0) { acc[0] += sky[0]; acc[1] += sky[1]; acc[2] += sky[2]; continue; }
        const hx = ox + dx * hitT, hy = oy + dy * hitT, hz = oz + dz * hitT;
        const i3 = h * 3;
        let hnx = gn[i3], hny = gn[i3 + 1], hnz = gn[i3 + 2];
        if (hnx * dx + hny * dy + hnz * dz > 0) { hnx = -hnx; hny = -hny; hnz = -hnz; }
        Lo(hx, hy, hz, hnx, hny, hnz, triMat[h], 0, rnd, sub);
        acc[0] += sub[0]; acc[1] += sub[1]; acc[2] += sub[2];
      }
    }
    E[0] += (Math.PI / N) * acc[0];
    E[1] += (Math.PI / N) * acc[1];
    E[2] += (Math.PI / N) * acc[2];
    return E;
  };

  /**
   * ⭐⭐ THE SAME FIXED DIRECTION SET `shadeHit` USES, EVALUATED AGAINST THE
   * TRUTH — the whole "is 4 directions enough" question, answered offline.
   *
   * `gatherProbes.shadeTerms` builds `SKY_RAYS` cosine directions from the FACE
   * NORMAL alone: elevation `r1 = (k + ½)/N`, azimuth from the VAN DER CORPUT
   * radical inverse of `k`, turned into a Duff tangent frame. Every face sharing
   * a normal therefore evaluates the SAME N world directions — which is what
   * makes the estimator deterministic, and also what makes its error a fixed
   * function of what those N directions HIT. Two neighbouring faces differ only
   * by origin, so their errors are CORRELATED, and no amount of spatial
   * smoothing or temporal re-shading can average them out.
   *
   * This reproduces that set exactly and evaluates each direction's incident
   * radiance with the path tracer, averaged over `reps` sub-paths so the only
   * error left is the DIRECTION QUANTIZATION. The direct emitter term is the
   * exact NEE both sides share (GI2's `Enee`), so the comparison isolates the
   * quadrature and nothing else.
   */
  const irradianceQuad = (p, n, N, reps, seed) => {
    const rnd = mulberry32(seed >>> 0);
    const [px, py, pz] = p;
    let [nx, ny, nz] = n;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const E = [0, 0, 0];
    neeE(px, py, pz, nx, ny, nz, 64, rnd, tmpE);
    E[0] += tmpE[0]; E[1] += tmpE[1]; E[2] += tmpE[2];
    const sgn = nz >= 0 ? 1 : -1;
    const a0 = -1 / (sgn + nz);
    const b0 = nx * ny * a0;
    const t1x = 1 + sgn * nx * nx * a0, t1y = sgn * b0, t1z = -sgn * nx;
    const t2x = b0, t2y = sgn + ny * ny * a0, t2z = -ny;
    const ox = px + nx * EPS * 20, oy = py + ny * EPS * 20, oz = pz + nz * EPS * 20;
    const sub = [0, 0, 0];
    const bits = Math.max(1, Math.log2(N));
    for (let k = 0; k < N; k++) {
      const r1 = (k + 0.5) / N;
      let r2 = 0;
      for (let b = 0; b < bits; b++) r2 += ((k >> b) & 1) * 2 ** -(bits - b);
      const rr = Math.sqrt(r1), phi = 2 * Math.PI * r2;
      const cz2 = Math.sqrt(Math.max(0, 1 - r1));
      let dx = t1x * (rr * Math.cos(phi)) + t2x * (rr * Math.sin(phi)) + nx * cz2;
      let dy = t1y * (rr * Math.cos(phi)) + t2y * (rr * Math.sin(phi)) + ny * cz2;
      let dz = t1z * (rr * Math.cos(phi)) + t2z * (rr * Math.sin(phi)) + nz * cz2;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      const acc = [0, 0, 0];
      for (let r = 0; r < reps; r++) {
        const h = intersect(ox, oy, oz, dx, dy, dz, 1e6);
        if (h < 0) { acc[0] += sky[0]; acc[1] += sky[1]; acc[2] += sky[2]; continue; }
        const hx = ox + dx * hitT, hy = oy + dy * hitT, hz = oz + dz * hitT;
        const i3 = h * 3;
        let hnx = gn[i3], hny = gn[i3 + 1], hnz = gn[i3 + 2];
        if (hnx * dx + hny * dy + hnz * dz > 0) { hnx = -hnx; hny = -hny; hnz = -hnz; }
        Lo(hx, hy, hz, hnx, hny, hnz, triMat[h], 0, rnd, sub);
        acc[0] += sub[0]; acc[1] += sub[1]; acc[2] += sub[2];
      }
      const w = Math.PI / (N * reps);
      E[0] += acc[0] * w; E[1] += acc[1] * w; E[2] += acc[2] * w;
    }
    return E;
  };

  return {
    irradianceQuad,
    intersect: (o, d, tMax = 1e6) => {
      const h = intersect(o[0], o[1], o[2], d[0], d[1], d[2], tMax);
      return h < 0 ? null : { tri: h, t: hitT, mat: triMat[h], n: [gn[h * 3], gn[h * 3 + 1], gn[h * 3 + 2]] };
    },
    irradiance,
    stats: { tris: count, nodes: bvh.nodes, emitTris: emitTris.length, emitArea },
  };
}
