// Pure CPU bake core — NO three.js imports, plain typed arrays and math —
// so the exact same code runs on the main thread (initial build) and inside
// bakeWorker.js (re-bakes). One implementation, two execution contexts:
// duplicating the bake math across main/worker is how transports silently
// drift apart (the failure mode this module's plan explicitly forbids).
//
// Inputs are serialized mesh records (see voxelizeOnce serializeMeshForBake):
//   { positions: Float32Array, index: Uint16/Uint32Array|null,
//     matrix: number[16] (column-major world matrix),
//     color: {r,g,b}, emissive: {r,g,b}, emissiveIntensity: number }
// Lights are plain objects: { type: "point"|"directional",
//   position/direction: {x,y,z}, color: {r,g,b}, intensity }.

export const SDF_CAP = 16;

export function allocateBakeArrays(cellCount) {
  return {
    albedo: new Float32Array(cellCount * 3),
    emissive: new Float32Array(cellCount * 3),
    normalAcc: new Float32Array(cellCount * 3),
    sampleCount: new Uint32Array(cellCount),
    occupied: new Uint8Array(cellCount),
    radiance: new Float32Array(cellCount * 4),
    surface: new Float32Array(cellCount * 4),
    normals: new Float32Array(cellCount * 4),
    distance: new Float32Array(cellCount),
  };
}

/**
 * Full bake pipeline: rasterize records → direct-light bake → exact EDT.
 * Fills `arrays` in place and returns stats. All semantics carried over
 * verbatim from the original in-place implementation: skip-don't-clamp
 * out-of-bounds samples, |ndotl| for thin-plane facing, 0.35 normal
 * reliability gate (emissive exempt), Lambert /π, EDT (not chamfer).
 */
export function runBake({ records, bounds, res, cell, lights, arrays }) {
  const { albedo, emissive, normalAcc, sampleCount, occupied, radiance, surface, normals, distance } =
    arrays;
  const cellCount = res.x * res.y * res.z;
  const minCell = Math.min(cell.x, cell.y, cell.z);
  const stats = { triangles: 0, occupiedCells: 0, litCells: 0, emissiveCells: 0, cellCount };
  const cellIndexOf = (ix, iy, iz) => (iz * res.y + iy) * res.x + ix;

  albedo.fill(0);
  emissive.fill(0);
  normalAcc.fill(0);
  sampleCount.fill(0);
  occupied.fill(0);
  radiance.fill(0);
  surface.fill(0);
  normals.fill(0);

  // ---------------------------------------------------------------- rasterize
  for (const record of records) {
    const { positions, index, matrix: m, color, emissive: emissiveColor, emissiveIntensity } = record;
    const vertexCount = index ? index.length : positions.length / 3;
    const triCount = vertexCount / 3;

    for (let tri = 0; tri < triCount; tri++) {
      const i0 = index ? index[tri * 3] : tri * 3;
      const i1 = index ? index[tri * 3 + 1] : tri * 3 + 1;
      const i2 = index ? index[tri * 3 + 2] : tri * 3 + 2;
      // world-transform the three vertices (column-major matrix)
      const transformed = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let corner = 0; corner < 3; corner++) {
        const vi = corner === 0 ? i0 : corner === 1 ? i1 : i2;
        const lx = positions[vi * 3];
        const ly = positions[vi * 3 + 1];
        const lz = positions[vi * 3 + 2];
        transformed[corner * 3] = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
        transformed[corner * 3 + 1] = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
        transformed[corner * 3 + 2] = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
      }
      const ax = transformed[0];
      const ay = transformed[1];
      const az = transformed[2];
      const e1x = transformed[3] - ax;
      const e1y = transformed[4] - ay;
      const e1z = transformed[5] - az;
      const e2x = transformed[6] - ax;
      const e2y = transformed[7] - ay;
      const e2z = transformed[8] - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const doubleArea = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (doubleArea < 1e-10) continue;
      nx /= doubleArea;
      ny /= doubleArea;
      nz /= doubleArea;
      stats.triangles++;

      const len1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
      const len2 = Math.sqrt(e2x * e2x + e2y * e2y + e2z * e2z);
      const bcx = transformed[6] - transformed[3];
      const bcy = transformed[7] - transformed[4];
      const bcz = transformed[8] - transformed[5];
      const len3 = Math.sqrt(bcx * bcx + bcy * bcy + bcz * bcz);
      const longestEdge = Math.max(len1, len2, len3);
      // Half-voxel barycentric lattice: no crossed cell is skipped.
      const samples = Math.max(1, Math.ceil((longestEdge / minCell) * 2));
      for (let a = 0; a <= samples; a++) {
        for (let b = 0; b <= samples - a; b++) {
          const u = a / samples;
          const v = b / samples;
          const px = ax + e1x * u + e2x * v;
          const py = ay + e1y * u + e2y * v;
          const pz = az + e1z * u + e2z * v;
          // Skip (don't clamp) out-of-grid samples — clamping merges a
          // boundary wall's outer face into the inner face's cells and
          // cancels the normals (kills the direct bake shell-wide).
          const fx = (px - bounds.min.x) / cell.x;
          const fy = (py - bounds.min.y) / cell.y;
          const fz = (pz - bounds.min.z) / cell.z;
          if (fx < 0 || fy < 0 || fz < 0 || fx >= res.x || fy >= res.y || fz >= res.z) continue;
          const ci = cellIndexOf(Math.floor(fx), Math.floor(fy), Math.floor(fz));
          occupied[ci] = 1;
          albedo[ci * 3] = color.r;
          albedo[ci * 3 + 1] = color.g;
          albedo[ci * 3 + 2] = color.b;
          emissive[ci * 3] = emissiveColor.r * emissiveIntensity;
          emissive[ci * 3 + 1] = emissiveColor.g * emissiveIntensity;
          emissive[ci * 3 + 2] = emissiveColor.b * emissiveIntensity;
          normalAcc[ci * 3] += nx;
          normalAcc[ci * 3 + 1] += ny;
          normalAcc[ci * 3 + 2] += nz;
          sampleCount[ci]++;
        }
      }
    }
  }

  // ------------------------------------------------------------ direct light
  const marchBlocked = (fromX, fromY, fromZ, dirX, dirY, dirZ, maxT) => {
    const stepLen = minCell * 0.5;
    for (let t = minCell * 1.5; t < maxT - minCell; t += stepLen) {
      const ix = Math.floor((fromX + dirX * t - bounds.min.x) / cell.x);
      const iy = Math.floor((fromY + dirY * t - bounds.min.y) / cell.y);
      const iz = Math.floor((fromZ + dirZ * t - bounds.min.z) / cell.z);
      if (ix < 0 || iy < 0 || iz < 0 || ix >= res.x || iy >= res.y || iz >= res.z) return false;
      if (occupied[cellIndexOf(ix, iy, iz)]) return true;
    }
    return false;
  };

  const sizeX = bounds.max.x - bounds.min.x;
  const sizeY = bounds.max.y - bounds.min.y;
  const sizeZ = bounds.max.z - bounds.min.z;
  const gridDiagonal = Math.sqrt(sizeX * sizeX + sizeY * sizeY + sizeZ * sizeZ);

  for (let iz = 0; iz < res.z; iz++) {
    for (let iy = 0; iy < res.y; iy++) {
      for (let ix = 0; ix < res.x; ix++) {
        const ci = cellIndexOf(ix, iy, iz);
        if (!occupied[ci]) continue;
        stats.occupiedCells++;
        radiance[ci * 4 + 3] = 1;
        let r = emissive[ci * 3];
        let g = emissive[ci * 3 + 1];
        let b = emissive[ci * 3 + 2];
        if (r + g + b > 1e-4) stats.emissiveCells++;

        const cx = bounds.min.x + (ix + 0.5) * cell.x;
        const cy = bounds.min.y + (iy + 0.5) * cell.y;
        const cz = bounds.min.z + (iz + 0.5) * cell.z;
        let nAx = normalAcc[ci * 3];
        let nAy = normalAcc[ci * 3 + 1];
        let nAz = normalAcc[ci * 3 + 2];
        const nLen = Math.sqrt(nAx * nAx + nAy * nAy + nAz * nAz);
        // Reliability |Σn|/count: junction cells (opposing faces sharing a
        // cell) → ~0 → no direct (garbled normal would light them like a
        // decal); emissive stays — it's isotropic.
        const reliability = nLen / Math.max(1, sampleCount[ci]);
        if (nLen > 1e-4) {
          nAx /= nLen;
          nAy /= nLen;
          nAz /= nLen;
        }
        surface[ci * 4] = albedo[ci * 3];
        surface[ci * 4 + 1] = albedo[ci * 3 + 1];
        surface[ci * 4 + 2] = albedo[ci * 3 + 2];
        surface[ci * 4 + 3] = reliability;
        normals[ci * 4] = nAx;
        normals[ci * 4 + 1] = nAy;
        normals[ci * 4 + 2] = nAz;

        let cellLit = false;
        if (reliability < 0.35) {
          radiance[ci * 4] = r;
          radiance[ci * 4 + 1] = g;
          radiance[ci * 4 + 2] = b;
          continue;
        }
        for (const entry of lights) {
          let lx;
          let ly;
          let lz;
          let dist;
          if (entry.type === "directional") {
            const dLen =
              Math.sqrt(
                entry.direction.x * entry.direction.x +
                  entry.direction.y * entry.direction.y +
                  entry.direction.z * entry.direction.z,
              ) || 1;
            lx = -entry.direction.x / dLen;
            ly = -entry.direction.y / dLen;
            lz = -entry.direction.z / dLen;
            dist = gridDiagonal;
          } else {
            lx = entry.position.x - cx;
            ly = entry.position.y - cy;
            lz = entry.position.z - cz;
            dist = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1e-6;
            lx /= dist;
            ly /= dist;
            lz /= dist;
          }
          // |ndotl|: thin planes have arbitrary facing — light both sides.
          const ndotl = Math.abs(nAx * lx + nAy * ly + nAz * lz);
          if (ndotl <= 1e-4) continue;
          if (marchBlocked(cx, cy, cz, lx, ly, lz, dist)) continue;
          // Lambertian outgoing = albedo · E / π (multi-bounce compounds
          // any excess; the /π keeps enclosed rooms convergent).
          const atten =
            (entry.type === "directional" ? entry.intensity : entry.intensity / Math.max(1, dist * dist)) /
            Math.PI;
          r += albedo[ci * 3] * entry.color.r * atten * ndotl;
          g += albedo[ci * 3 + 1] * entry.color.g * atten * ndotl;
          b += albedo[ci * 3 + 2] * entry.color.b * atten * ndotl;
          cellLit = true;
        }
        if (cellLit) stats.litCells++;
        radiance[ci * 4] = r;
        radiance[ci * 4 + 1] = g;
        radiance[ci * 4 + 2] = b;
      }
    }
  }

  computeDistanceField(occupied, distance, res, cell);
  return stats;
}

/**
 * EXACT Euclidean distance transform (separable Felzenszwalb over squared
 * distances). Chamfer variants advance in quantized 1/√2/√3 increments whose
 * metric ridges showed straight through the shadow penumbra as hard layer
 * transitions. Output: linear distance in minCell units, capped at SDF_CAP.
 */
export function computeDistanceField(occupied, distance, res, cell) {
  const cellCount = res.x * res.y * res.z;
  const minCell = Math.min(cell.x, cell.y, cell.z);
  const INF = 1e12;
  const n = Math.max(res.x, res.y, res.z);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  const dt1d = (count, pitch) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    const s2 = pitch * pitch;
    for (let q = 1; q < count; q++) {
      let sVal;
      while (true) {
        const p = v[k];
        sVal = (f[q] + s2 * q * q - (f[p] + s2 * p * p)) / (2 * s2 * (q - p));
        if (sVal <= z[k]) k--;
        else break;
      }
      k++;
      v[k] = q;
      z[k] = sVal;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < count; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      d[q] = s2 * (q - p) * (q - p) + f[p];
    }
  };

  for (let i = 0; i < cellCount; i++) distance[i] = occupied[i] ? 0 : INF;
  const sx = cell.x / minCell;
  const sy = cell.y / minCell;
  const sz = cell.z / minCell;
  for (let iz = 0; iz < res.z; iz++) {
    for (let iy = 0; iy < res.y; iy++) {
      const base = (iz * res.y + iy) * res.x;
      for (let ix = 0; ix < res.x; ix++) f[ix] = distance[base + ix];
      dt1d(res.x, sx);
      for (let ix = 0; ix < res.x; ix++) distance[base + ix] = d[ix];
    }
  }
  for (let iz = 0; iz < res.z; iz++) {
    for (let ix = 0; ix < res.x; ix++) {
      for (let iy = 0; iy < res.y; iy++) f[iy] = distance[(iz * res.y + iy) * res.x + ix];
      dt1d(res.y, sy);
      for (let iy = 0; iy < res.y; iy++) distance[(iz * res.y + iy) * res.x + ix] = d[iy];
    }
  }
  for (let iy = 0; iy < res.y; iy++) {
    for (let ix = 0; ix < res.x; ix++) {
      for (let iz = 0; iz < res.z; iz++) f[iz] = distance[(iz * res.y + iy) * res.x + ix];
      dt1d(res.z, sz);
      for (let iz = 0; iz < res.z; iz++) distance[(iz * res.y + iy) * res.x + ix] = d[iz];
    }
  }
  for (let i = 0; i < cellCount; i++) distance[i] = Math.min(SDF_CAP, Math.sqrt(distance[i]));
}
