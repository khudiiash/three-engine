// JS mirror of `gi2BvhAnyHit` (shadowBvh.js) — lifted from run-gi2-shadow-bvh-check.mjs for in-page/CPU probes.
export function triHit(tris, ti, ro, rd, maxT) {
  const o = ti * 9;
  const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
  const e1x = tris[o + 3] - ax, e1y = tris[o + 4] - ay, e1z = tris[o + 5] - az;
  const e2x = tris[o + 6] - ax, e2y = tris[o + 7] - ay, e2z = tris[o + 8] - az;
  const hx = rd[1] * e2z - rd[2] * e2y, hy = rd[2] * e2x - rd[0] * e2z, hz = rd[0] * e2y - rd[1] * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-9) return false;
  const inv = 1 / det;
  const sx = ro[0] - ax, sy = ro[1] - ay, sz = ro[2] - az;
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < -1e-5 || u > 1.00001) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (rd[0] * qx + rd[1] * qy + rd[2] * qz) * inv;
  if (v < -1e-5 || u + v > 1.00001) return false;
  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return tt > 1e-4 && tt < maxT;
}

export function bvhAnyHit(bvh, soupTris, ro, rd, maxT, options = null) {
  const { nodes, triIdx } = bvh;
  const owners = options?.owners ?? null;
  const excluded = options?.excluded ?? null;
  const skipOwner = options?.skipOwner ?? 0xffffffff;
  const ownerOf = (ti) => owners
    ? (owners[ti >> 1] >>> ((ti & 1) * 16)) & 0xffff
    : 0xffff;
  const safe = (d) => (Math.abs(d) > 1e-20 ? d : (d >= 0 ? 1e-20 : -1e-20));
  const inv = [1 / safe(rd[0]), 1 / safe(rd[1]), 1 / safe(rd[2])];
  const stack = new Uint32Array(64);
  let sp = 0; stack[0] = 0;
  let guard = 0, visited = 0, tested = 0;
  while (sp >= 0 && guard++ <= 4096) {
    const ni = stack[sp--]; visited++;
    const nb = ni * 8;
    let tmin = -Infinity, tmax = Infinity;
    for (let a = 0; a < 3; a++) {
      const t0 = (nodes[nb + a] - ro[a]) * inv[a], t1 = (nodes[nb + 4 + a] - ro[a]) * inv[a];
      tmin = Math.max(tmin, Math.min(t0, t1));
      tmax = Math.min(tmax, Math.max(t0, t1));
    }
    const entry = Math.max(tmin, 0);
    if (tmax < entry || entry > maxT) continue;
    const count = nodes[nb + 7];
    if (count < 0) {
      const right = nodes[nb + 3];
      if (sp < 62) { stack[++sp] = ni + 1; stack[++sp] = right; }
    } else {
      const first = nodes[nb + 3], n = count;
      for (let i = 0; i < n; i++) {
        const ti = triIdx[first + i];
        const owner = ownerOf(ti);
        if (owner === skipOwner || (excluded && (excluded[owner >> 5] & (1 << (owner & 31))) !== 0)) continue;
        tested++;
        // ⭐ THE LINE THIS GATE EXISTS FOR — the 6.2 indirection.
        if (triHit(soupTris, ti, ro, rd, maxT)) return { hit: 1, visited, tested };
      }
    }
  }
  return { hit: 0, visited, tested };
}

export function bruteAnyHit(soupTris, triCount, ro, rd, maxT) {
  for (let i = 0; i < triCount; i++) if (triHit(soupTris, i, ro, rd, maxT)) return 1;
  return 0;
}

