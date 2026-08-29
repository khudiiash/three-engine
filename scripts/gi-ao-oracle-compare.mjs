// grain = |AO_default − AO_reference| per region, from two run-gi-ao-oracle dumps.
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, "utf8")));
const dec = (s) => new Float32Array(Uint8Array.from(Buffer.from(s, "base64")).buffer);
const A = dec(a.ao), B = dec(b.ao);
const R = Uint8Array.from(Buffer.from(a.region, "base64")), R2 = Uint8Array.from(Buffer.from(b.region, "base64"));
const rn = { 1: "floor", 2: "edge", 3: "foliage", 4: "other" };
let mism = 0;
for (const r of [1, 2, 3, 4]) {
  const d = []; let mean = 0;
  for (let i = 0; i < A.length; i++) {
    if (R[i] !== r) continue;
    if (R2[i] !== r) { mism++; continue; }
    d.push(Math.abs(A[i] - B[i])); mean += B[i];
  }
  if (!d.length) { console.log(`  ${rn[r]}: none`); continue; }
  mean /= d.length; d.sort((p, q) => p - q);
  const q = (f) => (d[Math.floor(d.length * f)] / mean * 100).toFixed(2);
  console.log(`  grain ${rn[r].padEnd(8)} n ${String(d.length).padStart(7)}  ref mean ${mean.toFixed(3)}  p50 ${q(0.5)}%  p90 ${q(0.9)}%  p99 ${q(0.99)}%`);
}
console.log(`  region mismatches between runs: ${mism} (pose/gbuffer parity — must be ~0)`);
