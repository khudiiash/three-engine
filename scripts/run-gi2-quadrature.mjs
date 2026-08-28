// ⭐⭐ HOW MANY DIRECTIONS DOES A CACHE FACE NEED? — OFFLINE, AGAINST THE TRUTH.
//
// ══ WHY THIS IS NOT A GPU A/B ════════════════════════════════════════════════
//
// `SKY_RAYS` is a TIER CONSTANT compiled into `probeTrace`'s WGSL (it is the
// `end` of a `Loop`), so flipping it is a source change in `gatherProbes.js`,
// which this agent does not own. But the question it answers does not need the
// GPU at all: the direction set is FIXED and PUBLISHED — elevation
// `(k + ½)/N`, azimuth the van der Corput radical inverse of `k`, in a Duff
// tangent frame built from the face normal alone — so the estimator's error can
// be evaluated against a path-traced truth on the CPU, on the very same room,
// at the very same surface points the per-pixel gate scored.
//
// ⭐ AND THAT IS A STRICTLY BETTER MEASUREMENT THAN THE A/B WOULD BE. A GPU arm
// changes the direction count AND everything downstream of it at once (the
// cache's Neumann iteration, the smoother, the probe field, the resolve). This
// isolates the one thing in question: what a fixed N-direction cosine
// quadrature of the true incident radiance costs, in the units the gate scores.
//
// ══ WHAT IT PRINTS ══════════════════════════════════════════════════════════
//
// Per surface, for N ∈ {4, 8, 16, 32}: the σ of (E_N − E_exact) over the
// surface's own mean — the gate's blotch metric — and the count of samples the
// quadrature drives to BLACK (< 5 % of the truth). N = 4 is what ships.
//
// ⚠ THE SUB-PATH NOISE IS AVERAGED AWAY, ON PURPOSE. Each of the N directions
// is evaluated `REPS` times with independent continuation paths and averaged,
// so what remains is the DIRECTION QUANTIZATION and nothing else. A measurement
// that left the sub-path noise in would be reporting its own variance.
//
// Run:  IN=/tmp/cornell-before.json node scripts/run-gi2-quadrature.mjs
// Env:  IN · REPS=48 · MAXPTS=140 · BOUNCES=4 · REFSPP=4096
import { readFileSync } from "node:fs";
import { makeSceneTracer, lum } from "./lib/gi2SceneReference.mjs";

const IN = process.env.IN ?? "/tmp/cornell-before.json";
const REPS = Number(process.env.REPS ?? 48);
const MAXPTS = Number(process.env.MAXPTS ?? 140);
const BOUNCES = Number(process.env.BOUNCES ?? 4);
const REFSPP = Number(process.env.REFSPP ?? 4096);
const NS = (process.env.NS ?? "4,8,16,32").split(",").map(Number);

const f = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : "—");
const pct = (v, n = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(n)} %` : "—");
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const gate = JSON.parse(readFileSync(IN, "utf8"));
if (!gate.scene?.tri?.length) {
  console.log(`  ${IN} carries no scene — re-run probe:gi2-cornell to write one.`);
  process.exit(1);
}
const tracer = makeSceneTracer({
  tris: new Float32Array(gate.scene.tri),
  triMat: new Int32Array(gate.scene.triMat),
  mats: gate.scene.mats,
  sky: gate.sky ?? [0, 0, 0],
}, BOUNCES);

console.log("\n══ HOW MANY DIRECTIONS DOES A CACHE FACE NEED? ═══════════════");
console.log(`  ${IN} · ${tracer.stats.tris} tris · ${tracer.stats.emitTris} emissive · ` +
  `N ∈ {${NS.join(", ")}} · ${REPS} sub-paths per direction · ${BOUNCES} bounces`);

// The gate's UNBIASED per-surface sample; emitter faces are already excluded
// there, and so is anything the gate could not classify.
const bySurf = new Map();
for (const s of gate.sampleList ?? []) {
  if (s.surf === "unclassified") continue;
  if (!bySurf.has(s.surf)) bySurf.set(s.surf, []);
  bySurf.get(s.surf).push(s);
}
if (!bySurf.size) { console.log("  no sampleList in the gate output."); process.exit(1); }

const t0 = Date.now();
const rows = [];
for (const [name, all] of [...bySurf.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const step = Math.max(1, Math.floor(all.length / MAXPTS));
  const pts = all.filter((_, i) => i % step === 0);
  const exact = pts.map((s, i) => lum(tracer.irradiance(s.p, s.n, REFSPP, 0x5eed + i * 7919, 64)));
  const row = { name, n: pts.length, meanRef: mean(exact), byN: {} };
  for (const N of NS) {
    const q = pts.map((s, i) => lum(tracer.irradianceQuad(s.p, s.n, N, REPS, 0xa11ce + i * 104729)));
    const resid = q.map((v, i) => v - exact[i]);
    const mres = mean(resid);
    row.byN[N] = {
      sigmaRel: Math.sqrt(mean(resid.map((v) => (v - mres) ** 2))) / Math.max(1e-9, row.meanRef),
      bias: mres / Math.max(1e-9, row.meanRef),
      black: q.filter((v, i) => exact[i] > 0.02 && v < 0.05 * exact[i]).length,
    };
  }
  // What the GPU actually produced at these same points, for scale.
  row.gpuSigmaRel = (() => {
    const resid = pts.map((s, i) => s.E - exact[i]);
    const m = mean(resid);
    return Math.sqrt(mean(resid.map((v) => (v - m) ** 2))) / Math.max(1e-9, row.meanRef);
  })();
  rows.push(row);
  process.stdout.write(`\r  ${rows.length}/${bySurf.size} surfaces  ${Math.round((Date.now() - t0) / 1000)}s   `);
}
console.log(`\r  ${rows.length} surfaces in ${Math.round((Date.now() - t0) / 1000)}s                   `);

console.log("");
console.log("  σ(E_N − E_exact) / mean, and the samples driven BLACK by the quadrature alone");
console.log(`  surface            pts   E_exact   GPU σ  |${NS.map((N) => `   N=${N}`.padStart(10)).join("")}  |${NS.map((N) => `  blk${N}`.padStart(8)).join("")}`);
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(16)} ${String(r.n).padStart(5)}  ${f(r.meanRef).padStart(8)} ${pct(r.gpuSigmaRel).padStart(7)}  |` +
    NS.map((N) => pct(r.byN[N].sigmaRel).padStart(10)).join("") + "  |" +
    NS.map((N) => String(r.byN[N].black).padStart(8)).join(""),
  );
}
console.log("");
console.log("  bias (mean of E_N − E_exact) / mean — a quadrature must not move the ENERGY");
console.log(`  surface           ${NS.map((N) => `   N=${N}`.padStart(10)).join("")}`);
for (const r of rows) {
  console.log(`  ${r.name.padEnd(16)} ` + NS.map((N) => pct(r.byN[N].bias).padStart(10)).join(""));
}
const agg = (N, k) => mean(rows.map((r) => r.byN[N][k]));
console.log("");
console.log("  ── VERDICT ──────────────────────────────────────────────────────────");
for (const N of NS) {
  console.log(`  N = ${String(N).padStart(2)}   σ̄/mean ${pct(agg(N, "sigmaRel")).padStart(8)}   ` +
    `|bias|̄ ${pct(Math.abs(agg(N, "bias"))).padStart(7)}   black ${rows.reduce((a, r) => a + r.byN[N].black, 0)}`);
}
console.log(`  GPU (as shipped, N = 4 plus everything downstream)   σ̄/mean ${pct(mean(rows.map((r) => r.gpuSigmaRel)))}`);
