// VXAO ESTIMATOR BENCH — scores the shipped cone march against brute-force
// ray-cast AO over the SAME voxels, offline.
//
// Every measured constant in `traceOccupancyConeAO` (occupancyField.js) and in
// `createGiVxaoPass` (giScreen.js) is chosen here, and the comments at those
// constants quote this output. Re-run it before changing any of them.
//
//   npm run probe:gi-vxao-dump -- http://127.0.0.1:5201/   (captures the data)
//   npm run bench:gi-vxao
//
// The reference is not another estimator: it is a cosine-weighted hemisphere of
// exact level-0 DDA rays through the occupancy bits, i.e. the answer the cone
// march is an approximation OF. Floor points whose reference origin lands
// inside a conservative shell are dropped — there every ray hits at t=0 for a
// reason that has nothing to do with occlusion, and one such point (under the
// contact box, invisible to any camera) otherwise dominates max|error|.
import { loadDump, coneVisibility, referenceVisibility, smooth } from "./lib/vxaoOffline.mjs";
import { VXAO_SUBJECTS } from "./lib/makeVxaoProject.mjs";

const D = loadDump();
const N = { x: 0, y: 1, z: 0 };

// The shipped configuration: aoRadius 0.5 (giConfig) x 4 = a 2 m reach.
const REACH = Number(process.env.REACH ?? 2.0);
const SHIPPED_SCALE = 1 / 3;
const SHIPPED_WINDOW = 0.4;
const win = (f) => (tm, R) => 1 - smooth(R * f, R, tm);

const grid = [];
for (let x = -4.2; x <= 4.2; x += 0.4) for (let z = -4.2; z <= 4.2; z += 0.4) grid.push({ x, y: 0.015, z });
const pts = grid.filter((P) => {
  const lift = { x: P.x, y: P.y + D.voxMin * 1.5, z: P.z };
  return D.rayHit(lift, { x: 1, y: 0, z: 0 }, 0.02) !== 0
    && D.rayHit(lift, { x: 0, y: 1, z: 0 }, 0.02) !== 0;
});

const score = (opts, falloff, reach = REACH, refs = null) => {
  let sum = 0, sumSq = 0, max = 0;
  const bucket = new Map();
  pts.forEach((P, i) => {
    const cone = coneVisibility(D, P, N, reach, { ...opts, falloff }).vis;
    const ref = refs ? refs[i] : referenceVisibility(D, P, N, reach, { falloff, rays: 1500 });
    const e = cone - ref;
    sum += e; sumSq += e * e; if (Math.abs(e) > max) max = Math.abs(e);
    const k = Math.round(ref * 5) / 5;
    const acc = bucket.get(k) ?? { n: 0, e: 0 };
    acc.n++; acc.e += e; bucket.set(k, acc);
  });
  const n = pts.length;
  return { bias: sum / n, rms: Math.sqrt(sumSq / n), max, bucket };
};
const buckets = (b) => [0.4, 0.6, 0.8, 1.0]
  .map((k) => { const a = b.get(k); return a ? (a.e / a.n).toFixed(3).padStart(6) : "     -"; })
  .join(" ");

console.log(`${pts.length} floor points of ${grid.length} (rest dropped as inside-shell), voxel ${D.voxMin.toFixed(4)} m\n`);

// ── 1. AO_OCCLUDER_VOXELS (tau): volume fraction -> projected coverage ──────
const refsShipped = pts.map((P) => referenceVisibility(D, P, N, REACH, { falloff: win(SHIPPED_WINDOW), rays: 1500 }));
console.log(`AO_OCCLUDER_VOXELS at reach ${REACH} m, ${SHIPPED_WINDOW}R window`);
console.log("  tau    bias      rms     max|e|   error by reference bucket 0.4 / 0.6 / 0.8 / 1.0");
for (const tau of [1, 2, 2.5, 3, 4]) {
  const r = score({ coverageScale: 1 / tau }, win(SHIPPED_WINDOW), REACH, refsShipped);
  console.log(`  ${String(tau).padEnd(5)} ${r.bias.toFixed(4).padStart(8)}  ${r.rms.toFixed(4)}  ${r.max.toFixed(3)}    ${buckets(r.bucket)}`);
}

// ── 2. The range window ─────────────────────────────────────────────────────
console.log(`\nrange window at reach ${REACH} m, tau 3`);
console.log("  start  bias      rms     max|e|   error by reference bucket");
for (const f of [0.2, 0.4, 0.6, 0.8, 0.95]) {
  const r = score({ coverageScale: SHIPPED_SCALE }, win(f));
  console.log(`  ${f.toFixed(2)}  ${r.bias.toFixed(4).padStart(8)}  ${r.rms.toFixed(4)}  ${r.max.toFixed(3)}    ${buckets(r.bucket)}`);
}

// ── 3. The reach multiplier ─────────────────────────────────────────────────
console.log(`\nreach (aoRadius 0.5 x N), tau 3, ${SHIPPED_WINDOW}R window`);
console.log("  xN   reach   bias      rms     max|e|");
for (const mult of [2, 3, 4, 5, 6]) {
  const reach = 0.5 * mult;
  const r = score({ coverageScale: SHIPPED_SCALE }, win(SHIPPED_WINDOW), reach);
  console.log(`  ${String(mult).padEnd(4)} ${reach.toFixed(1)} m  ${r.bias.toFixed(4).padStart(8)}  ${r.rms.toFixed(4)}  ${r.max.toFixed(3)}`);
}

// ── 4. The gate's two subjects, for run-gi-vxao-probe.mjs ───────────────────
console.log(`\ngate subjects at the shipped configuration (strength 1, so texel == visibility)`);
let hidden = null, open = null;
for (const [label, p] of Object.entries(VXAO_SUBJECTS)) {
  const P = { x: p[0], y: p[1], z: p[2] };
  const cone = coneVisibility(D, P, N, REACH, { coverageScale: SHIPPED_SCALE, falloff: win(SHIPPED_WINDOW) }).vis;
  const ref = referenceVisibility(D, P, N, REACH, { falloff: win(SHIPPED_WINDOW), rays: 4000 });
  if (label === "hiddenFloor") hidden = { cone, ref };
  if (label === "openFloor") open = { cone, ref };
  console.log(`  ${label.padEnd(15)} cone ${cone.toFixed(4)}   reference ${ref.toFixed(4)}`);
}
console.log(
  `  off-screen occluder darkening: cone ${(open.cone - hidden.cone).toFixed(4)}, ` +
  `truth ${(open.ref - hidden.ref).toFixed(4)}`,
);
