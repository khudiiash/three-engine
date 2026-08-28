// §19 STAGE 6.2 — THE INDEXED SHADOW BVH, CHECKED AGAINST BRUTE FORCE
//
// ⭐⭐⭐ WHAT THIS GATE IS FOR. 6.2 stopped materializing the BVH's triangles and
// started shipping a `Uint32Array` PERMUTATION into the soup's own resident
// buffer. That change moves one indirection into the GPU's leaf loop, and the
// entire class of bug it opens is invisible to every statistic the build
// reports: a tree with perfect bounds, a perfect depth and a perfect leaf
// histogram will happily test THE WRONG TRIANGLES if `first + i` is applied to
// the soup instead of to the index, or if the index is applied twice.
//
// The build cannot catch that, because the build is what produced it. So this
// gate mirrors the SHIPPING WGSL's traversal in JS — the same node layout, the
// same `triIdx[first+i] * 9` addressing, the same Möller-Trumbore, the same
// any-hit early out — and compares its answer, ray by ray, against a brute-force
// test of every triangle. Disagreement on ONE ray fails the gate.
//
// ⚠ THE RAYS ARE NOT ALL RANDOM. Axis-aligned rays against axis-aligned
// geometry are the case the shader's `safeDir` guard exists for (a 0 * Inf NaN
// in the slab test), and a uniform random direction essentially never produces
// one. A fixed axis-aligned battery runs alongside the random one.
//
//   node scripts/run-gi2-shadow-bvh-check.mjs
import { buildShadowBvh } from "../src/modules/gi/window/shadowBvh.worker.js";

// ── A SCENE WITH THE SHAPES THAT BREAK THINGS ───────────────────────────────
// Axis-aligned walls (the NaN case), a thin panel (the case the voxel arm
// cannot represent at all), and scattered clutter so the SAH actually splits.
function makeSoup() {
  const tris = [];
  const quad = (a, b, c, d) => { tris.push(...a, ...b, ...c); tris.push(...a, ...c, ...d); };
  const x0 = -5, x1 = 5, y0 = 0, y1 = 6, z0 = -5, z1 = 5;
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // floor
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); // ceiling
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -x
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +x
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); // -z
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
  // a 5 cm-thin panel standing in the middle — two faces inside one voxel
  const t = 0.025;
  for (const sx of [-t, t]) quad([sx, 0, -2], [sx, 0, 2], [sx, 3, 2], [sx, 3, -2]);
  // clutter, on a deterministic LCG so a failure is reproducible
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 400; i++) {
    const px = (rnd() - 0.5) * 8, py = rnd() * 5, pz = (rnd() - 0.5) * 8, s = 0.05 + rnd() * 0.3;
    tris.push(px, py, pz, px + s, py, pz, px, py + s, pz + s * 0.5);
  }
  return { tris: new Float32Array(tris), triCount: tris.length / 9 };
}

// ── THE SHIPPING TRAVERSAL, MIRRORED ────────────────────────────────────────
// Kept deliberately literal against the WGSL in `shadowBvh.js` — including the
// finite pseudo-infinity, which is the whole point of the axis-aligned battery.
function triHit(tris, ti, ro, rd, maxT) {
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

function bvhAnyHit(bvh, soupTris, ro, rd, maxT) {
  const { nodes, triIdx } = bvh;
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
        tested++;
        // ⭐ THE LINE THIS GATE EXISTS FOR — the 6.2 indirection.
        if (triHit(soupTris, triIdx[first + i], ro, rd, maxT)) return { hit: 1, visited, tested };
      }
    }
  }
  return { hit: 0, visited, tested };
}

function bruteAnyHit(soupTris, triCount, ro, rd, maxT) {
  for (let i = 0; i < triCount; i++) if (triHit(soupTris, i, ro, rd, maxT)) return 1;
  return 0;
}

// ── RUN ─────────────────────────────────────────────────────────────────────
const soup = makeSoup();
const t0 = performance.now();
const bvh = buildShadowBvh({ tris: soup.tris.slice(), triCount: soup.triCount, maxLeafSize: 8 });
const buildMs = performance.now() - t0;

console.log(`[gate] soup ${soup.triCount} tris`);
console.log(`[gate] bvh  ${bvh.triCount} tris, ${bvh.nodeCount} nodes, depth ${bvh.stats.maxDepth}, `
  + `${(bvh.bytes / 1024).toFixed(1)} KB, ${buildMs.toFixed(1)} ms`);

let fail = 0;
const checks = [];

// (a) COMPLETENESS — the whole reason 6.2 exists.
if (bvh.triCount !== soup.triCount) {
  console.log(`  FAIL completeness: ${bvh.triCount} of ${soup.triCount}`); fail++;
} else checks.push(`complete (${bvh.triCount}/${soup.triCount})`);
if (bvh.stats.truncated) { console.log("  FAIL truncated flag set"); fail++; }

// (b) THE INDEX IS A PERMUTATION — every soup triangle referenced exactly once.
{
  const seen = new Uint8Array(soup.triCount);
  let dup = 0, oob = 0;
  for (let i = 0; i < bvh.triIdx.length; i++) {
    const v = bvh.triIdx[i];
    if (v >= soup.triCount) { oob++; continue; }
    if (seen[v]++) dup++;
  }
  let missing = 0;
  for (let i = 0; i < seen.length; i++) if (seen[i] === 0) missing++;
  if (oob || dup || missing) {
    console.log(`  FAIL permutation: oob=${oob} dup=${dup} missing=${missing}`); fail++;
  } else checks.push("index is a clean permutation");
}

// (c) MEMORY — the budget claim, as a number rather than an intention.
{
  const bytesPerTri = bvh.bytes / bvh.triCount;
  checks.push(`${bytesPerTri.toFixed(1)} B/tri (nodes + index; the triangles are the soup's)`);
  if (bytesPerTri > 20) {
    console.log(`  FAIL ${bytesPerTri.toFixed(1)} B/tri is over the 20 B/tri 6.2 budget`); fail++;
  }
}

// (d) TRAVERSAL == BRUTE FORCE, on random AND axis-aligned rays.
{
  let seed = 999;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rays = [];
  for (let i = 0; i < 3000; i++) {
    const ro = [(rnd() - 0.5) * 9, rnd() * 5.5, (rnd() - 0.5) * 9];
    let d = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    const L = Math.hypot(d[0], d[1], d[2]) || 1;
    d = d.map((v) => v / L);
    rays.push([ro, d, 0.5 + rnd() * 12]);
  }
  const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let i = 0; i < 600; i++) {
    const ro = [Math.round((rnd() - 0.5) * 18) / 2, Math.round(rnd() * 12) / 2, Math.round((rnd() - 0.5) * 18) / 2];
    rays.push([ro, axes[i % 6], 0.5 + rnd() * 12]);
  }
  let bad = 0, hits = 0, vis = 0, tst = 0, nan = 0;
  for (const [ro, rd, maxT] of rays) {
    const g = bvhAnyHit(bvh, soup.tris, ro, rd, maxT);
    const b = bruteAnyHit(soup.tris, soup.triCount, ro, rd, maxT);
    if (!Number.isFinite(g.hit)) nan++;
    if (g.hit !== b) {
      if (bad < 5) {
        console.log(`  MISMATCH ro=${ro.map((v) => v.toFixed(2))} rd=${rd.map((v) => v.toFixed(2))} `
          + `maxT=${maxT.toFixed(2)} bvh=${g.hit} brute=${b}`);
      }
      bad++;
    }
    hits += b; vis += g.visited; tst += g.tested;
  }
  if (bad || nan) {
    console.log(`  FAIL ${bad} mismatches, ${nan} non-finite over ${rays.length} rays`); fail++;
  } else checks.push(`${rays.length} rays agree with brute force (${hits} occluded)`);
  console.log(`[gate] traversal: ${(vis / rays.length).toFixed(1)} nodes and `
    + `${(tst / rays.length).toFixed(1)} tri-tests per ray`);
}

for (const c of checks) console.log(`  ok — ${c}`);
console.log(fail === 0
  ? "\nPASS — the indexed tree is complete and traverses exactly."
  : `\nFAIL — ${fail} check(s)`);
process.exit(fail === 0 ? 0 : 1);
