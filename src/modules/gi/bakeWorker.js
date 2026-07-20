// Bake worker: runs the full CPU bake (rasterize + direct light + EDT) off
// the main thread. Also DIFFS each result against the previous bake (cheap
// here, expensive on the main thread) so the main thread can apply PARTIAL
// GPU uploads — full re-uploads of every buffer were a 30-60ms main-thread
// stall per rebake at fine voxel sizes (the "worker offloaded but still
// spikes" report).
import { allocateBakeArrays, runBake } from "./bakeCore.js";

let arrays = null;
let prev = null; // persistent copy of the last result, diff baseline
let allocatedCellCount = -1;

// [startFloat, endFloatExclusive] of differing elements, or null if equal.
const diffRange = (current, previous) => {
  const n = current.length;
  let start = 0;
  while (start < n && current[start] === previous[start]) start++;
  if (start === n) return null;
  let end = n - 1;
  while (end > start && current[end] === previous[end]) end--;
  return [start, end + 1];
};

self.onmessage = (event) => {
  const { jobId, records, bounds, res, cell, lights } = event.data;
  const cellCount = res.x * res.y * res.z;
  if (cellCount !== allocatedCellCount) {
    arrays = allocateBakeArrays(cellCount);
    prev = {
      radiance: new Float32Array(cellCount * 4),
      surface: new Float32Array(cellCount * 4),
      normals: new Float32Array(cellCount * 4),
      distance: new Float32Array(cellCount),
    };
    allocatedCellCount = cellCount;
  }
  const started = performance.now();
  const stats = runBake({ records, bounds, res, cell, lights, arrays });
  const ranges = {
    radiance: diffRange(arrays.radiance, prev.radiance),
    surface: diffRange(arrays.surface, prev.surface),
    normals: diffRange(arrays.normals, prev.normals),
    distance: diffRange(arrays.distance, prev.distance),
  };
  prev.radiance.set(arrays.radiance);
  prev.surface.set(arrays.surface);
  prev.normals.set(arrays.normals);
  prev.distance.set(arrays.distance);
  const elapsed = performance.now() - started;
  self.postMessage(
    {
      jobId,
      stats,
      elapsed,
      ranges,
      radiance: arrays.radiance,
      surface: arrays.surface,
      normals: arrays.normals,
      distance: arrays.distance,
    },
    [arrays.radiance.buffer, arrays.surface.buffer, arrays.normals.buffer, arrays.distance.buffer],
  );
  // Result buffers were transferred away — reallocate them next job but
  // KEEP `prev` (the diff baseline) and the untransferred scratch fields.
  const scratch = arrays;
  arrays = allocateBakeArrays(cellCount);
  arrays.albedo = scratch.albedo;
  arrays.emissive = scratch.emissive;
  arrays.normalAcc = scratch.normalAcc;
  arrays.sampleCount = scratch.sampleCount;
  arrays.occupied = scratch.occupied;
};
