// IN-PAGE HALF OF `run-gi2-puddle-probe.mjs`'S ORIGIN CENSUS (§19 Stage 4.4).
//
// ⭐⭐ WHY THE ORIGIN AND NOT THE DIRECTIONS. The puddle receipt's worst-pair
// dump shows two probes SIX CENTIMETRES APART, tracing the SAME 64 fixed
// directions, disagreeing along one direction by 100× — hit 11.45 m carrying
// L 0.858 against hit 5.02 m carrying L 0.007. Six centimetres of parallax at a
// five-metre silhouette is 0.7°, and an oct texel is 14° wide, so the two rays
// are the same ray: what differs is where they START.
//
// And `windowTrace`'s origin is not where the caller put it. It is biased half
// a cell along the normal and then ESCAPED — if the biased point's own voxel is
// occupied the origin walks a WHOLE LEVEL-0 CELL outward, up to `ORIGIN_ESCAPE`
// times. So a probe's real trace origin is `p + (0.5 + k)·v₀·n` for an integer
// k that depends on the CONSERVATIVE voxelization's local thickness — and two
// probes on one flat wall can get different k. That is a quarter-metre step in
// the origin of all 64 rays, decided by a lattice, which is exactly the shape of
// a 30-60 px patch on a wall six metres away.
//
// This rig measures k directly. `traceWindow` with a ZERO normal takes neither
// the bias nor the escape, so firing outward along the surface normal from
// `p + s·n` and asking how far the ray gets says whether that point is inside
// the occupied set: inside, the DDA leaves through the current voxel's far face
// within a cell diagonal; outside, it flies. Three offsets per probe give k.
//
// ⚠ It also takes `biasCells` per ray, which is what makes the FIX measurable
// from the harness before it is a source edit: the same 64 directions traced at
// a different bias, with no engine change and no rebuild.
import { Fn, instanceIndex, instancedArray, uint, vec3 } from "three/tsl";
import { unpackTrace } from "/src/modules/gi/window/windowTrace.js";

const MAX_RAYS = 4096;

/**
 * @param {object} gi2      the live `createGi2System` object
 * @param {object} renderer the engine's WebGPURenderer
 * @returns {(rays: Array<{o:number[], d:number[], n?:number[], tMax?:number,
 *   bias?:number}>) => Promise<Array>}  `unpackTrace` rows, in order.
 *   `n` omitted (or zero) means NO bias and NO escape — the raw DDA from `o`.
 */
export function createGi2OriginProbe(gi2, renderer) {
  let rig = gi2.__probeOriginRig;
  if (!rig) {
    // 3 vec4 in: (origin, tMax) (dir, biasCells) (normal, 0)
    const rayIn = instancedArray(new Float32Array(MAX_RAYS * 12), "vec4");
    const rayOut = instancedArray(new Float32Array(MAX_RAYS * 4), "vec4");
    const pass = Fn(() => {
      const i = instanceIndex.toVar();
      const b = i.mul(uint(3)).toVar();
      const a0 = rayIn.element(b).toVar();
      const a1 = rayIn.element(b.add(uint(1))).toVar();
      const a2 = rayIn.element(b.add(uint(2))).toVar();
      const r = gi2.trace.traceWindow(a0.xyz, a1.xyz, a0.w, vec3(a2.xyz), a1.w);
      rayOut.element(i).assign(r.raw);
    })().compute(MAX_RAYS);
    pass.__giPassName = "probe.gi2origin";
    rig = gi2.__probeOriginRig = { rayIn, rayOut, pass };
  }
  const { rayIn, rayOut, pass } = rig;
  return async (rays) => {
    const arr = rayIn.value.array;
    arr.fill(0);
    const n = Math.min(MAX_RAYS, rays.length);
    for (let i = 0; i < n; i++) {
      const r = rays[i];
      const b = i * 12;
      arr[b] = r.o[0]; arr[b + 1] = r.o[1]; arr[b + 2] = r.o[2]; arr[b + 3] = r.tMax ?? 40;
      arr[b + 4] = r.d[0]; arr[b + 5] = r.d[1]; arr[b + 6] = r.d[2];
      arr[b + 7] = r.bias ?? 0.5;
      if (r.n) { arr[b + 8] = r.n[0]; arr[b + 9] = r.n[1]; arr[b + 10] = r.n[2]; }
    }
    rayIn.value.needsUpdate = true;
    await renderer.computeAsync(pass);
    const raw = new Float32Array(await renderer.getArrayBufferAsync(rayOut.value));
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(unpackTrace(raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2], raw[i * 4 + 3]));
    }
    return out;
  };
}

export const GI2_ORIGIN_MAX_RAYS = MAX_RAYS;
