// OFFLINE VXAO BENCH — replays the cone march, and a brute-force reference AO,
// against the real voxel data captured by run-gi-vxao-diag.mjs. Lets a change
// to the estimator be judged against GROUND TRUTH in a second instead of a
// three-minute editor boot.
//
//   Data comes from scripts/run-gi-vxao-diag.mjs (npm run probe:gi-vxao-dump).
import { readFileSync } from "node:fs";

export function loadDump(file = "scripts/.gi-vxao/vxao-dump.json") {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const [rx, ry, rz] = raw.res0;
  const bits = Buffer.from(raw.occupancyB64, "base64");
  const vox = { x: raw.voxel[0], y: raw.voxel[1], z: raw.voxel[2] };
  const org = { x: raw.origin[0], y: raw.origin[1], z: raw.origin[2] };
  const inv = { x: 1 / vox.x, y: 1 / vox.y, z: 1 / vox.z };
  const voxMin = Math.min(vox.x, vox.y, vox.z);
  const dens = new Map();
  for (const d of raw.densityDump) dens.set(d.L, { res: d.res, bytes: Uint8Array.from(d.bytes) });

  const occAt = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= rx || y >= ry || z >= rz) return 0;
    const i = (z * ry + y) * rx + x;
    return (bits[i >> 3] >> (i & 7)) & 1;
  };
  const densAt = (x, y, z, L) => {
    const d = dens.get(L);
    if (!d) return 0;
    const [dx, dy, dz] = d.res;
    if (x < 0 || y < 0 || z < 0 || x >= dx || y >= dy || z >= dz) return 0;
    return d.bytes[(z * dy + y) * dx + x] / 255;
  };
  const triAt = (q, L) => {
    const s = 2 ** L;
    const cx = q.x / s - 0.5, cy = q.y / s - 0.5, cz = q.z / s - 0.5;
    const bx = Math.floor(cx), by = Math.floor(cy), bz = Math.floor(cz);
    const fx = cx - bx, fy = cy - by, fz = cz - bz;
    const g = (a, b, c) => densAt(bx + a, by + b, bz + c, L);
    const d00 = g(0, 0, 0) * (1 - fx) + g(1, 0, 0) * fx;
    const d10 = g(0, 1, 0) * (1 - fx) + g(1, 1, 0) * fx;
    const d01 = g(0, 0, 1) * (1 - fx) + g(1, 0, 1) * fx;
    const d11 = g(0, 1, 1) * (1 - fx) + g(1, 1, 1) * fx;
    return (d00 * (1 - fy) + d10 * fy) * (1 - fz) + (d01 * (1 - fy) + d11 * fy) * fz;
  };
  const toGrid = (p) => ({ x: (p.x - org.x) * inv.x, y: (p.y - org.y) * inv.y, z: (p.z - org.z) * inv.z });

  /** Exact level-0 DDA. Returns world distance to the first set voxel, or Infinity. */
  const rayHit = (origin, dir, tMax) => {
    const q = toGrid(origin);
    const d = { x: dir.x * inv.x, y: dir.y * inv.y, z: dir.z * inv.z };
    let vx = Math.floor(q.x), vy = Math.floor(q.y), vz = Math.floor(q.z);
    const sx = d.x > 0 ? 1 : -1, sy = d.y > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
    const dxr = Math.abs(d.x) < 1e-9 ? Infinity : 1 / Math.abs(d.x);
    const dyr = Math.abs(d.y) < 1e-9 ? Infinity : 1 / Math.abs(d.y);
    const dzr = Math.abs(d.z) < 1e-9 ? Infinity : 1 / Math.abs(d.z);
    let tx = dxr === Infinity ? Infinity : ((d.x > 0 ? vx + 1 - q.x : q.x - vx) * dxr);
    let ty = dyr === Infinity ? Infinity : ((d.y > 0 ? vy + 1 - q.y : q.y - vy) * dyr);
    let tz = dzr === Infinity ? Infinity : ((d.z > 0 ? vz + 1 - q.z : q.z - vz) * dzr);
    let t = 0;
    for (let i = 0; i < 4096; i++) {
      if (vx < 0 || vy < 0 || vz < 0 || vx >= rx || vy >= ry || vz >= rz) return Infinity;
      if (occAt(vx, vy, vz)) return t;
      if (tx <= ty && tx <= tz) { t = tx; vx += sx; tx += dxr; }
      else if (ty <= tz) { t = ty; vy += sy; ty += dyr; }
      else { t = tz; vz += sz; tz += dzr; }
      if (t > tMax) return Infinity;
    }
    return Infinity;
  };

  return { rx, ry, rz, vox, org, inv, voxMin, occAt, densAt, triAt, toGrid, rayHit };
}

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/** Frame from a normal, matching the shader's Duff ONB. */
export function onb(N) {
  const sgn = N.z >= 0 ? 1 : -1;
  const a = -1 / (sgn + N.z);
  const b = N.x * N.y * a;
  return {
    T: { x: 1 + sgn * N.x * N.x * a, y: sgn * b, z: -sgn * N.x },
    B: { x: b, y: sgn + N.y * N.y * a, z: -N.y },
  };
}

/** The shipped cone set: 1 axial + 5 at 60° elevation, cosine-weighted. */
export function coneSet(N) {
  const SZ = Math.cos(Math.PI / 3), SR = Math.sin(Math.PI / 3);
  const { T, B } = onb(N);
  const cones = [{ d: { ...N }, w: 1 / (1 + 5 * SZ), label: "axial" }];
  for (let k = 0; k < 5; k++) {
    const a = (k * 2 * Math.PI) / 5;
    const ca = Math.cos(a) * SR, sa = Math.sin(a) * SR;
    cones.push({
      d: { x: N.x * SZ + T.x * ca + B.x * sa, y: N.y * SZ + T.y * ca + B.y * sa, z: N.z * SZ + T.z * ca + B.z * sa },
      w: SZ / (1 + 5 * SZ),
      label: `side${k}`,
    });
  }
  return cones;
}

/**
 * The shipped march, parameterised so variants can be compared.
 * `falloff(tm, reach)` returns the per-step range weight.
 */
export function coneMarch(D, origin, dir, tMin, tMax, tanHalf, recvP, recvN, opts = {}) {
  const steps = opts.steps ?? 8;
  const stepMul = opts.stepMul ?? 1;
  const falloff = opts.falloff ?? ((tm, reach) => 1 - smooth(reach * 0.6, reach, tm));
  const finest = D.voxMin * 2;
  const q0 = D.toGrid(origin);
  const dq = { x: dir.x * D.inv.x, y: dir.y * D.inv.y, z: dir.z * D.inv.z };
  const reach = Math.max(tMax, finest);
  let t = Math.max(tMin, finest * 0.5);
  let alpha = 0;
  for (let i = 0; i < steps; i++) {
    if (t >= reach || alpha >= 0.995) break;
    const cell = Math.max(tanHalf * t, finest);
    const stepLen = cell * stepMul;
    const tm = t + stepLen * 0.5;
    const qm = { x: q0.x + dq.x * tm, y: q0.y + dq.y * tm, z: q0.z + dq.z * tm };
    if (qm.x < 0 || qm.y < 0 || qm.z < 0 || qm.x >= D.rx || qm.y >= D.ry || qm.z >= D.rz) break;
    const lod = Math.min(4, Math.max(1, Math.log2(cell / D.voxMin)));
    const lf = Math.floor(lod);
    const dens = D.triAt(qm, lf) * (1 - (lod - lf)) + D.triAt(qm, Math.min(4, lf + 1)) * (lod - lf);
    const pw = { x: qm.x * D.vox.x + D.org.x, y: qm.y * D.vox.y + D.org.y, z: qm.z * D.vox.z + D.org.z };
    const planeD = recvN.x * (pw.x - recvP.x) + recvN.y * (pw.y - recvP.y) + recvN.z * (pw.z - recvP.z);
    const above = smooth(D.voxMin * -0.25, D.voxMin * 0.75, planeD);
    // The coverage factor must be the SAMPLED cell's width, not the cone's:
    // once lod saturates, the sample no longer grows with the cone.
    const widthInVoxels = opts.rawCell ? cell / D.voxMin : 2 ** lod;
    const a = Math.min(1, Math.max(0, dens * above * widthInVoxels * (opts.coverageScale ?? 1) * stepMul));
    alpha += (1 - alpha) * a * falloff(tm, reach);
    t += stepLen;
  }
  return 1 - alpha;
}

/** Cone-traced visibility at a surface point, using the shipped cone set. */
export function coneVisibility(D, P, N, reach, opts = {}) {
  const finest = D.voxMin * 2;
  const origin = { x: P.x + N.x * finest * 1.5, y: P.y + N.y * finest * 1.5, z: P.z + N.z * finest * 1.5 };
  const tanHalf = opts.tanHalf ?? Math.tan(Math.PI / 6);
  let vis = 0;
  const per = [];
  for (const c of coneSet(N)) {
    const v = coneMarch(D, origin, c.d, finest * 0.5, reach, tanHalf, P, N, opts);
    per.push([c.label, +v.toFixed(3)]);
    vis += v * c.w;
  }
  return { vis, per };
}

/**
 * REFERENCE: brute-force cosine-weighted hemisphere visibility against the
 * level-0 bits. `restrictToConeSet` measures only what the shipped cone set
 * can see, which separates "is the march a good cone integrator" from "is the
 * cone set a good hemisphere sampler".
 */
export function referenceVisibility(D, P, N, reach, opts = {}) {
  const rays = opts.rays ?? 4000;
  const falloff = opts.falloff ?? ((t) => 1 - smooth(reach * 0.6, reach, t));
  const { T, B } = onb(N);
  const lift = D.voxMin * 1.5;
  const o = { x: P.x + N.x * lift, y: P.y + N.y * lift, z: P.z + N.z * lift };
  const cones = opts.restrictToConeSet ? coneSet(N) : null;
  const cosCone = Math.cos(Math.PI / 6);
  let num = 0, den = 0;
  // Stratified golden-ratio cosine hemisphere.
  for (let i = 0; i < rays; i++) {
    const u1 = (i + 0.5) / rays;
    const u2 = (i * 0.618033988749895) % 1;
    const r = Math.sqrt(u1), phi = 2 * Math.PI * u2;
    const x = r * Math.cos(phi), y = r * Math.sin(phi), z = Math.sqrt(Math.max(0, 1 - u1));
    const d = { x: T.x * x + B.x * y + N.x * z, y: T.y * x + B.y * y + N.y * z, z: T.z * x + B.z * y + N.z * z };
    if (cones) {
      let inAny = false;
      for (const c of cones) if (c.d.x * d.x + c.d.y * d.y + c.d.z * d.z >= cosCone) { inAny = true; break; }
      if (!inAny) continue;
    }
    den += 1; // cosine-distributed sampling already carries the cos weight
    const t = D.rayHit(o, d, reach);
    if (t < reach) num += falloff(t, reach);
  }
  return den ? 1 - num / den : 1;
}

export { smooth };
