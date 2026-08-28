// GI2 — THE CPU PATH-TRACED REFERENCE, SHARED BY EVERY §19 PARITY PROBE.
//
// ⭐⭐ ONE PATH TRACER, NOT ONE PER PROBE. It was `run-gi2-gather-probe.mjs`'s
// private code until §19 3.15 needed a SECOND scene — the 60 m corridor, which
// is the far-field reference 3.14's verdict named as the missing instrument
// ("1.6× the screen path is not the same claim as 1.6× the truth"). A second
// copy of a reference is a second description of the truth, and it drifts the
// first time someone edits one of them. The gather probe's own header already
// makes this argument one level down: the reference receives the scene,
// palette and lights FROM THE PAGE so the two cannot disagree about the room.
// The same argument applies to the tracer itself.
//
// Nothing here knows about Cornell, corridors, tiers or WebGPU. It receives
// `scene` (the fill's own primitive list), `palette` and `light`, and returns
// `irradiance(p, n, spp, seed)` — the exact quantity the GPU resolve writes.
// ── the CPU reference ────────────────────────────────────────────────────────

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const mulv = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** A rotation, as its three COLUMNS — the form `windowFill.js` publishes. */
export const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export const rot = (R, v) => [0, 1, 2].map((a) => R[0][a] * v[0] + R[1][a] * v[1] + R[2][a] * v[2]);
export const rotT = (R, v) => [0, 1, 2].map((k) => R[k][0] * v[0] + R[k][1] * v[1] + R[k][2] * v[2]);

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

/**
 * A path tracer over the page's analytic scene.
 *
 * The estimator mirrors the GPU's exactly where the GPU is exact and differs
 * only where the GPU approximates: direct light is next-event (sun by a shadow
 * ray, panel by one area sample), indirect is a cosine-sampled bounce to
 * `bounces` deep, and the sun is a DELTA direction so a bounce ray can never
 * hit it — the same reason the GPU's gather cannot double-count it.
 */
export function makeReference(scene, palette, light, bounces = 4, R = IDENTITY) {
  const EPS = 1e-4;
  const panel = light.panel;
  const sunTo = norm(mul(light.sunDir, -1));
  // ⭐ §19 STAGE 3.9 — THE ROTATED ROOM IS INTERSECTED IN ITS OWN FRAME.
  //
  // `KIND_OBB` primitives (2) carry LOCAL `min`/`max` and the arm's rotation
  // turns them. Rather than write an OBB intersector, the RAY is turned into
  // that frame — `R` is orthonormal so `t` is the same number on both sides
  // and only the normal has to come back — and the world-space primitives (the
  // panel, the sphere) keep the intersector they already had. The two answers
  // are compared by `t`, which is the only comparison that means anything
  // across the two frames.
  const boxes = scene.filter((p) => p.kind !== 2).map((p, i) => ({ ...p, i }));
  const local = scene.filter((p) => p.kind === 2).map((p, i) => ({ ...p, kind: 0, i }));

  const intersectIn = (list, o, d) => {
    let bt = Infinity;
    let bn = null;
    let bp = -1;
    for (const p of list) {
      if (p.kind !== 1) {
        let t0 = -Infinity, t1 = Infinity, a0 = 0, a1 = 0, s0 = -1, s1 = 1;
        let miss = false;
        for (let a = 0; a < 3 && !miss; a++) {
          if (Math.abs(d[a]) < 1e-12) {
            if (o[a] < p.min[a] || o[a] > p.max[a]) miss = true;
            continue;
          }
          const inv = 1 / d[a];
          let tE, tX, nE, nX;
          if (inv >= 0) { tE = (p.min[a] - o[a]) * inv; tX = (p.max[a] - o[a]) * inv; nE = -1; nX = 1; }
          else { tE = (p.max[a] - o[a]) * inv; tX = (p.min[a] - o[a]) * inv; nE = 1; nX = -1; }
          if (tE > t0) { t0 = tE; a0 = a; s0 = nE; }
          if (tX < t1) { t1 = tX; a1 = a; s1 = nX; }
        }
        if (miss || t1 < t0 || t1 < EPS) continue;
        const useEntry = t0 > EPS;
        const t = useEntry ? t0 : t1;
        if (t >= bt || t < EPS) continue;
        bt = t;
        bn = [0, 0, 0];
        bn[useEntry ? a0 : a1] = useEntry ? s0 : s1;
        bp = p.pal;
      } else {
        const c = [0, 1, 2].map((a) => (p.min[a] + p.max[a]) / 2);
        const r = (p.max[0] - p.min[0]) / 2;
        const oc = sub(o, c);
        const b = dot3(oc, d);
        const cc = dot3(oc, oc) - r * r;
        const disc = b * b - cc;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        let t = -b - sq;
        if (t < EPS) t = -b + sq;
        if (t < EPS || t >= bt) continue;
        bt = t;
        bn = norm(sub(add(o, mul(d, t)), c));
        bp = p.pal;
      }
    }
    return bn ? { t: bt, n: bn, pal: bp } : null;
  };

  const intersect = local.length === 0
    ? (o, d) => intersectIn(boxes, o, d)
    : (o, d) => {
      const a = intersectIn(boxes, o, d);
      const b = intersectIn(local, rotT(R, o), rotT(R, d));
      if (b && (!a || b.t < a.t)) return { t: b.t, n: rot(R, b.n), pal: b.pal };
      return a;
    };

  const occluded = (o, d, tMax) => {
    const h = intersect(o, d);
    return h != null && h.t < tMax;
  };

  const directE = (p, n, rnd) => {
    let E = [0, 0, 0];
    const ndl = dot3(n, sunTo);
    if (ndl > 0 && !occluded(add(p, mul(n, EPS * 10)), sunTo, 1e5)) {
      E = add(E, mul(light.sunColor, ndl));
    }
    if (p[1] < panel.centre[1] - 0.02) {
      const q = [
        panel.centre[0] + (rnd() - 0.5) * 2 * panel.half[0],
        panel.centre[1],
        panel.centre[2] + (rnd() - 0.5) * 2 * panel.half[1],
      ];
      const wv = sub(q, p);
      const d2 = Math.max(1e-4, dot3(wv, wv));
      const dd = Math.sqrt(d2);
      const w = mul(wv, 1 / dd);
      const cosX = Math.max(0, dot3(n, w));
      const cosP = Math.max(0, w[1]); // the panel faces −Y
      if (cosX * cosP > 0 && !occluded(add(p, mul(n, EPS * 10)), w, dd - 1e-3)) {
        E = add(E, mul(panel.radiance, (cosX * cosP * panel.area) / d2));
      }
    }
    return E;
  };

  const basis = (n) => {
    const a = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t = norm([
      a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0],
    ]);
    const b = [
      n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0],
    ];
    return [t, b];
  };
  const cosineDir = (n, rnd) => {
    const [t, b] = basis(n);
    const r = Math.sqrt(rnd());
    const phi = 2 * Math.PI * rnd();
    const x = r * Math.cos(phi);
    const y = r * Math.sin(phi);
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    return norm(add(add(mul(t, x), mul(b, y)), mul(n, z)));
  };

  const radiance = (o, d, depth, rnd) => {
    const h = intersect(o, d);
    if (!h) return light.sky;
    const p = add(o, mul(d, h.t));
    const n = dot3(h.n, d) < 0 ? h.n : mul(h.n, -1);
    const e = palette[h.pal] ?? { albedo: [0, 0, 0], emissive: 0 };
    let L = [e.emissive, e.emissive, e.emissive];
    L = add(L, mulv(mul(e.albedo, 1 / Math.PI), directE(p, n, rnd)));
    if (depth + 1 < bounces) {
      const w = cosineDir(n, rnd);
      // (albedo/π) · π · L_in — the π of the cosine-pdf estimator cancels.
      L = add(L, mulv(e.albedo, radiance(add(p, mul(n, EPS * 10)), w, depth + 1, rnd)));
    }
    return L;
  };

  /** Incident irradiance at (p, n) — the quantity the resolve writes. */
  const irradiance = (p, n, spp, seed) => {
    const rnd = mulberry32(seed);
    const o = add(p, mul(n, EPS * 20));
    let E = [0, 0, 0];
    for (let s = 0; s < spp; s++) E = add(E, radiance(o, cosineDir(n, rnd), 0, rnd));
    return mul(E, Math.PI / spp);
  };

  return { intersect, irradiance, radiance };
}
