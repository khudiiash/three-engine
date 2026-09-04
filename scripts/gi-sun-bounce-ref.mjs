// CPU GROUND TRUTH for the sun-bounce corridor (`scripts/gi-sun-bounce.html`).
//
// The corridor is three axis-aligned boxes and one directional source, so the
// indirect irradiance at a point is a path-traced integral with no geometry
// approximation anywhere in it — which is what makes it a TRUTH rather than a
// second opinion, and why this probe can report "the engine is 0.68x of the
// right answer" instead of "the engine looks dark".
//
// The scene is deliberately the smallest one that has the property under test:
// a surface lit ONLY by bounced sunlight, with a shadow line across the source
// wall so the answer is not simply "everything is lit". Used two ways:
//
//   node scripts/gi-sun-bounce-ref.mjs        prints the table
//   import { irradianceAt, PROBE_POINTS }     the probe prints truth beside
//                                             the engine's own gatherAt
//
// ⚠ IT IS MULTI-BOUNCE. A single-bounce reference is ~20% low at this albedo
// and the engine's secondary cache is not single-bounce, so a single-bounce
// truth would have shown a real engine as ~20% HOT and hidden that much of any
// deficit. Depth 4 at rho 0.216 converges to well under a percent.

import { readFileSync } from "node:fs";

const RHO = 0.216;          // 0x808080 sRGB = 0.216 linear
const SUN_I = 10;           // directional irradiance on a square-on surface
const SUN_TRAVEL = [1 / Math.SQRT2, -1 / Math.SQRT2, 0];
const TOWARD_SUN = SUN_TRAVEL.map((v) => -v);
// `MC_DEPTH=1` isolates the FIRST bounce. Worth having as a knob rather than a
// second script: "the engine converges to 0.33 against a 4-bounce truth of
// 0.48" and "the engine delivers exactly one bounce" are the same measurement
// read against two references, and only the pair distinguishes them.
const DEPTH = Number(process.env.MC_DEPTH ?? 4);

/**
 * ⭐ WALL THICKNESS IS A VARIABLE — `WALL_T=1.5` (metres, default 0.5).
 *
 * The walls grow OUTWARD ONLY: both INNER faces stay at x = ±1.75. That is the
 * whole point of the arm. Every probe point sits on an inner face, the shadow
 * line is cast by wall B's inner TOP EDGE (x = −1.75, y = 6), and the sun is
 * unchanged — so nothing the measurement looks at moves, and the ONLY thing
 * that changes is how many field cells the wall occupies.
 *
 * Why that is the experiment: at `spacing0` 0.45 (high) a 0.5 m wall is ~1.1
 * cells at c0 and THINNER THAN ONE CELL from c1 outward (0.9 / 1.8 / 3.6 m).
 * A cascade that cannot resolve the wall lets transport rays escape through it,
 * and an escaped bin contributes ZERO radiance at full cosine weight with the
 * sky off — energy loss — while contributing FULL sky radiance with it on —
 * energy gain. One mechanism, and it is the only candidate found so far that
 * predicts BOTH signs this rig measures (sun bounce 0.71-0.86x short, sky in
 * enclosure 1.4x hot).
 *
 * ⚠ The rig (`gi-sun-bounce.html`, `?thick=`) reads the same number from the
 * same env var through its runner. Geometry that exists twice must move twice.
 */
const WALL_T = Math.max(0.05, Number(process.env.WALL_T ?? 0.5));

const A = { min: [1.75, 0, -6], max: [1.75 + WALL_T, 6, 6] };   // wall A
const B = { min: [-1.75 - WALL_T, 0, -6], max: [-1.75, 6, 6] }; // wall B
const G = { min: [-4, -0.2, -6], max: [4, 0, 6] };              // ground
const BOXES = [A, B, G];

function hitBox(o, d, b, tMax) {
  let t0 = 1e-4, t1 = tMax;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / d[a];
    let ta = (b.min[a] - o[a]) * inv, tb = (b.max[a] - o[a]) * inv;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}
function trace(o, d) {
  let best = null;
  for (const b of BOXES) {
    const t = hitBox(o, d, b, 1e30);
    if (t != null && (best == null || t < best.t)) best = { t, box: b };
  }
  return best;
}
function normalAt(b, p) {
  const e = 1e-3;
  if (Math.abs(p[0] - b.min[0]) < e) return [-1, 0, 0];
  if (Math.abs(p[0] - b.max[0]) < e) return [1, 0, 0];
  if (Math.abs(p[1] - b.min[1]) < e) return [0, -1, 0];
  if (Math.abs(p[1] - b.max[1]) < e) return [0, 1, 0];
  if (Math.abs(p[2] - b.min[2]) < e) return [0, 0, -1];
  return [0, 0, 1];
}
const visible = (p) => !BOXES.some((b) => hitBox(p, TOWARD_SUN, b, 1e30) != null);

/** An orthonormal basis around `n` — the hemisphere the estimator samples. */
function basis(n) {
  const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t = [
    up[1] * n[2] - up[2] * n[1],
    up[2] * n[0] - up[0] * n[2],
    up[0] * n[1] - up[1] * n[0],
  ];
  const len = Math.hypot(...t);
  const tt = [t[0] / len, t[1] / len, t[2] / len];
  const bb = [
    n[1] * tt[2] - n[2] * tt[1],
    n[2] * tt[0] - n[0] * tt[2],
    n[0] * tt[1] - n[1] * tt[0],
  ];
  return [tt, bb];
}
/** Cosine-weighted direction around `n`. pdf = cos/pi, so the weight is 1. */
function cosineDir(n, rnd) {
  const [t, b] = basis(n);
  const r1 = rnd(), r2 = rnd();
  const phi = 2 * Math.PI * r1, s = Math.sqrt(r2), c = Math.sqrt(1 - r2);
  const x = s * Math.cos(phi), y = s * Math.sin(phi);
  return [
    t[0] * x + b[0] * y + n[0] * c,
    t[1] * x + b[1] * y + n[1] * c,
    t[2] * x + b[2] * y + n[2] * c,
  ];
}

/**
 * Indirect irradiance at `P` on a surface with normal `n`.
 *
 * `sun` and `skyL` are separable and both are reported, because the engine has
 * an arm for each and the interesting quantity is their RATIO — a shared gain
 * error cancels there and a transport error does not.
 *
 * `withShadow: false` is the `__giSrcNoShadow` arm's truth: every sun-facing
 * surface lit whether or not it can see the sun. Having both is what separates
 * "the transport loses energy" from "the shadow term removes too much".
 */
export function irradianceAt(P, n, { samples = 200000, skyL = 0.1, withShadow = true, seed = 1 } = {}) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) ^ (s >>> 12)) >>> 0;
    s = (Math.imul(s ^ (s >>> 7), 0x297a2d39) ^ (s >>> 15)) >>> 0;
    return s / 4294967296;
  };
  // §11.28 HDRI arm: `skyL` may be a FUNCTION of the escape direction (a
  // decoded environment map, `loadHdrSky`), so the truth carries the sky's
  // angular distribution — a sunset HDRI puts most of its light at the
  // horizon, exactly where an enclosure blocks it.
  const skyAt = typeof skyL === "function" ? skyL : () => skyL;
  let accSun = 0, accSky = 0, accSkyDirect = 0, escaped = 0;
  for (let i = 0; i < samples; i++) {
    let o = P, d = cosineDir(n, rnd), throughput = 1;
    for (let depth = 0; depth < DEPTH; depth++) {
      const h = trace(o, d);
      if (!h) {
        const L = skyAt(d);
        if (depth === 0) { escaped++; accSkyDirect += L; }
        accSky += throughput * L;
        break;
      }
      const q = [o[0] + d[0] * h.t, o[1] + d[1] * h.t, o[2] + d[2] * h.t];
      const nq = normalAt(h.box, q);
      const cos = nq[0] * TOWARD_SUN[0] + nq[1] * TOWARD_SUN[1] + nq[2] * TOWARD_SUN[2];
      const lifted = [q[0] + nq[0] * 1e-3, q[1] + nq[1] * 1e-3, q[2] + nq[2] * 1e-3];
      if (cos > 0 && (!withShadow || visible(lifted))) {
        accSun += throughput * (RHO / Math.PI) * SUN_I * cos;
      }
      throughput *= RHO;               // cosine sampling: the cos/pdf cancels
      o = lifted;
      d = cosineDir(nq, rnd);
    }
  }
  return {
    sun: Math.PI * (accSun / samples),
    sky: Math.PI * (accSky / samples),
    /** The sky seen DIRECTLY (depth 0) — what a no-bounce arm must reproduce. */
    skyDirect: Math.PI * (accSkyDirect / samples),
    escape: escaped / samples,
  };
}

/**
 * Decode a Radiance .hdr (RGBE, new-style RLE) into a luminance sampler over
 * directions, using three's equirect convention (`equirectUV`: u = atan2(z, x)
 * / 2π + ½, v = asin(y) / π + ½; row 0 of the file is v = 1, the zenith) and
 * scaled by the scene's environment intensity. Returns `(dir) => radiance`.
 */
export function loadHdrSky(path, intensity = 1) {
  const buf = readFileSync(path);
  let i = buf.indexOf("\n\n") + 2;
  const eol = buf.indexOf("\n", i);
  const [, hStr, , wStr] = buf.slice(i, eol).toString().trim().split(/\s+/);
  const H = Number(hStr);
  const W = Number(wStr);
  let pos = eol + 1;
  const lum = new Float32Array(W * H);
  const row = new Uint8Array(4 * W);
  for (let y = 0; y < H; y++) {
    if (buf[pos] === 2 && buf[pos + 1] === 2) {
      pos += 4;
      for (let ch = 0; ch < 4; ch++) {
        let x = 0;
        while (x < W) {
          const c = buf[pos++];
          if (c > 128) {
            const n = c - 128;
            const v = buf[pos++];
            for (let k = 0; k < n; k++) row[(x + k) * 4 + ch] = v;
            x += n;
          } else {
            for (let k = 0; k < c; k++) row[(x + k) * 4 + ch] = buf[pos + k];
            pos += c;
            x += c;
          }
        }
      }
    } else {
      row.set(buf.subarray(pos, pos + 4 * W));
      pos += 4 * W;
    }
    for (let x = 0; x < W; x++) {
      const e = row[x * 4 + 3];
      const scale = e > 0 ? 2 ** (e - 136) : 0;
      lum[y * W + x] = (0.2126 * row[x * 4] + 0.7152 * row[x * 4 + 1] + 0.0722 * row[x * 4 + 2]) * scale;
    }
  }
  const sky = (d) => {
    const u = Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5;
    const v = Math.asin(Math.max(-1, Math.min(1, d[1]))) / Math.PI + 0.5;
    const cx = ((Math.floor(u * W) % W) + W) % W;
    const cy = Math.min(H - 1, Math.max(0, Math.floor((1 - v) * H)));
    return lum[cy * W + cx] * intensity;
  };
  // The analytic open-sky irradiance for an up-facing point, for a receipt.
  let eUp = 0;
  for (let y = 0; y < H; y++) {
    const theta = ((y + 0.5) / H) * Math.PI;
    const dOmega = ((2 * Math.PI) / W) * (Math.PI / H) * Math.sin(theta);
    const cos = Math.cos(theta);
    if (cos <= 0) continue;
    let rowSum = 0;
    for (let x = 0; x < W; x++) rowSum += lum[y * W + x];
    eUp += rowSum * cos * dOmega;
  }
  sky.irradianceUp = eUp * intensity;
  sky.size = [W, H];
  return sky;
}

/**
 * THE OCCLUSION LADDER (2026-08-30) — the AO half of this instrument.
 *
 * USER REPORT: *"and AO as well — ours does not work enough to cover how it
 * covers in path tracer"* (Sponza, beside a path-traced render of the same
 * frame; the arcades and the foliage read deep and contact-dark there and flat
 * here).
 *
 * ⚠ THAT REPORT IS NOT NECESSARILY ABOUT THE AO PASS, AND THIS LADDER IS HOW
 * TO TELL. The engine splits occlusion in two by design (giScreen.js, the AO
 * block in `createGiResolve`): the cascade is supposed to carry every blocker
 * at or above the probe lattice, and the AO term is only the sub-lattice band
 * left over. A metre-deep arcade is squarely the CASCADE's half — so if the
 * cascade leaks light into a corner, no amount of AO is the fix, and turning
 * AO up to cover it would be charging the same occluder twice (which reads as
 * dirt, the thing the `min` composition exists to prevent).
 *
 * So measure the cascade ALONE — the rig runs with `ao: false` — against a
 * truth that has occlusion by construction. Under a uniform sky the answer is
 * unambiguous: a point that sees a fraction V of the hemisphere receives
 * V * pi * L before inter-reflection, and `irradianceAt` returns BOTH the full
 * multi-bounce sky irradiance and `escape` — the cosine-weighted fraction of
 * directions that leave on the first bounce, which IS the ground-truth ambient
 * occlusion factor at that point.
 *
 * The ladder runs from fully open to deeply enclosed, and it is the SHAPE that
 * carries the verdict, not any single ratio:
 *
 *   flat and ~1.00        the cascade carries occlusion correctly; look
 *                         elsewhere for the user's report (exposure, the AO
 *                         pass's own radius, the composition)
 *   rising as V falls     the cascade LEAKS into corners — the AO term is
 *                         being asked to paper over a transport deficit, and
 *                         the fix belongs in the cascade
 *   falling as V falls    the cascade over-occludes; AO on top would crush
 *
 * The open point doubles as an absolute-scale check: at V ~ 1 the answer must
 * be pi * L, the same calibration the `plane` scene makes.
 */
export const SKY_POINTS = [
  // Standing ON TOP of wall B. The other wall's top is at the same height, so
  // nothing rises above this point's horizon: V ~ 1, E ~ pi*L.
  { name: "wallB top (open sky)", P: [-2.0, 6.01, 0], n: [0, 1, 0] },
  // ⚠ EVERY POINT HERE MUST BE VISIBLE FROM THE RIG'S CAMERA. The probes are
  // screen-anchored, so an occluded point has no probe and reads a clean
  // 0.0000 — "no probe", not "no light" (gi-harness-viewport-traps). The first
  // cut of this ladder put its mid-V sample on the ground OUTSIDE the walls at
  // x 3.2, which wall A hides from a camera standing in the corridor: it read 0
  // at every mark and dragged the open mean from 0.92x to 0.46x, i.e. the
  // instrument invented half the effect it was built to measure. Everything
  // below is inside the corridor or on top of a wall.
  { name: "corridor floor at wall", P: [-1.6, 0.01, 0], n: [0, 1, 0] },
  { name: "wallB high (y 5.2)", P: [-1.74, 5.2, 0], n: [1, 0, 0] },
  { name: "wallB mid (y 2.2)", P: [-1.74, 2.2, 0], n: [1, 0, 0] },
  { name: "wallB low (y 0.3)", P: [-1.74, 0.3, 0], n: [1, 0, 0] },
  // The canyon floor: a 3.5 m slot between two 6 m walls, the deepest
  // enclosure the rig has and the closest analogue of a Sponza arcade.
  { name: "corridor floor centre", P: [0, 0.01, 0], n: [0, 1, 0] },
];

/**
 * ⭐⭐ THE DIRECTION SWEEP — the bin-level instrument §2.7 asked for, built at
 * LOBE level because that is the resolution the answer actually needs.
 *
 * Six mechanisms are refuted (plan §2.7i) and one suspect is left: the tile
 * bake's `E = pi * SUM(L*W) / SUM(W)` over KNOWN bins. That expression is the
 * cosine-weighted MEAN of the bins a ray happened to reach — exact for any
 * radiance field if those bins tile the hemisphere evenly, and biased exactly
 * as far as they do not. Point-level probes cannot see that: they integrate the
 * whole lobe and report one number, so a bias that cancels across directions
 * and a bias that does not look identical.
 *
 * So hold the POINT fixed and sweep the NORMAL. One position on wall B's inner
 * face, nine surface orientations rotating in the x-y plane from steeply down
 * (-70 deg) through straight across (+x, 0 deg) to steeply up (+70 deg). Both
 * sides answer the same question — "the irradiance of a surface at this point
 * with this normal" — so `irradianceAt(P, n)` is the truth with no new maths.
 *
 * ⭐ WHAT THE SHAPE DECIDES, and it is the shape and not any single ratio:
 *
 *   FLAT across theta      a scale error. The known-bin story is WRONG, because
 *                          a directional bias cannot integrate to a constant
 *                          fraction over every lobe orientation.
 *   DIPS at the boundary   confirmed. The deficit tracks how much of the lobe
 *                          straddles the shadow line on wall A, which is what
 *                          "the reachable bins are not a random subset" means
 *                          when you can finally see it per-direction.
 *   RISES toward the sky    the escape/sky bins are the ones carrying the error
 *                          (the same defect §2.7e measures with the sign
 *                          flipped, since here the sky is BLACK).
 *
 * The sun in this rig travels (1,-1,0)/sqrt2, and wall B's top edge casts the
 * line across wall A at y = 2.555 — so a lobe tilted UP sees mostly lit wall,
 * one tilted DOWN sees mostly shadowed wall, and the crossing is inside the
 * sweep by construction rather than by luck.
 *
 * ⚠ |theta| stops at 70 deg. Past that the surface is nearly tangent to the
 * wall it sits 1 cm off, and both sides start integrating grazing rays along
 * their own origin surface — physical, identical in both, and pure variance.
 */
const LOBE_P = [-1.74, 2.2, 0];
const LOBE_ANGLES = [-70, -52.5, -35, -17.5, 0, 17.5, 35, 52.5, 70];
export const LOBE_POINTS = LOBE_ANGLES.map((deg) => {
  const r = (deg * Math.PI) / 180;
  return {
    name: `n ${deg > 0 ? "+" : ""}${deg}deg ${deg === 0 ? "(across)" : deg > 0 ? "(up)" : "(down)"}`,
    P: LOBE_P,
    n: [Math.cos(r), Math.sin(r), 0],
    deg,
  };
});

/** The points both the CPU truth and the engine's `gatherAt` are asked about. */
export const PROBE_POINTS = [
  { name: "wallB mid (the MC point)", P: [-1.74, 2.2, 0], n: [1, 0, 0] },
  { name: "wallB high", P: [-1.74, 5.0, 0], n: [1, 0, 0] },
  { name: "wallB low", P: [-1.74, 0.8, 0], n: [1, 0, 0] },
  { name: "corridor floor", P: [0, 0.01, 0], n: [0, 1, 0] },
  { name: "wallA shadowed low", P: [1.74, 1.0, 0], n: [-1, 0, 0] },
];

// `process.argv[1]` is undefined under `node -e`, and this file is imported
// that way to sweep MC_DEPTH — so the guard has to survive not being a script.
const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry && import.meta.url.endsWith(entry.split("/").pop())) {
  const pad = (s, w) => String(s).padEnd(w);
  console.log(`corridor truth — rho ${RHO}, sun ${SUN_I} at 45deg, sky L 0.1, ${DEPTH} bounces`);
  console.log(pad("point", 26) + pad("E_sun", 9) + pad("E_sun noshadow", 16) + pad("E_sky", 9) + "sun/sky");
  for (const p of PROBE_POINTS) {
    const shadowed = irradianceAt(p.P, p.n);
    const open = irradianceAt(p.P, p.n, { withShadow: false });
    console.log(
      pad(p.name, 26) +
      pad(shadowed.sun.toFixed(4), 9) +
      pad(open.sun.toFixed(4), 16) +
      pad(shadowed.sky.toFixed(4), 9) +
      (shadowed.sun / shadowed.sky).toFixed(2),
    );
  }
  console.log(`a flat unoccluded plane under the same sky reads ${(Math.PI * 0.1).toFixed(4)}`);
}
