// How thick, in level-0 voxels, is a surface after conservative voxelization?
// That number is 1/coverageScale in the cone march.
import { loadDump } from "./lib/vxaoOffline.mjs";
const D = loadDump();
const runs = { x: [], y: [], z: [] };
const scan = (axis) => {
  const [nx, ny, nz] = [D.rx, D.ry, D.rz];
  const at = (a, b, c) => axis === "x" ? D.occAt(a, b, c) : axis === "y" ? D.occAt(b, a, c) : D.occAt(b, c, a);
  const [na, nb, nc] = axis === "x" ? [nx, ny, nz] : axis === "y" ? [ny, nx, nz] : [nz, nx, ny];
  for (let b = 0; b < nb; b++) for (let c = 0; c < nc; c++) {
    let run = 0;
    for (let a = 0; a < na; a++) {
      if (at(a, b, c)) run++;
      else { if (run > 0) runs[axis].push(run); run = 0; }
    }
    if (run > 0) runs[axis].push(run);
  }
};
for (const ax of ["x", "y", "z"]) scan(ax);
for (const ax of ["x", "y", "z"]) {
  const r = runs[ax].sort((a, b) => a - b);
  const mean = r.reduce((s, v) => s + v, 0) / r.length;
  const med = r[Math.floor(r.length / 2)];
  const hist = {};
  for (const v of r) hist[Math.min(v, 8)] = (hist[Math.min(v, 8)] ?? 0) + 1;
  console.log(`${ax}: ${r.length} runs  mean ${mean.toFixed(2)}  median ${med}  hist(len:count, 8=8+) ${JSON.stringify(hist)}`);
}
const all = [...runs.x, ...runs.y, ...runs.z];
console.log(`\nall axes: mean run ${(all.reduce((s, v) => s + v, 0) / all.length).toFixed(2)} voxels`);
