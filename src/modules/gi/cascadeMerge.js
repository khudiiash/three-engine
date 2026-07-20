// 3D Radiance Cascades — same-frame hierarchical merge (Phase 2).
//
// This is the pass the Shadertoy reference could not do: it merged
// temporally (reading last FRAME's coarser cascade) because Shadertoy has a
// single self-feedback buffer, and its comments blame exactly that for the
// flickering and light lag. Here each cascade's merge is its own compute
// dispatch, ordered coarsest → finest inside one renderer.compute(queue)
// submit, so cascade i reads cascade i+1's ALREADY-MERGED same-frame output.
//
// Per ray of cascade i:
//   hit in own interval  → radiance is its own (opaque hit blocks the far field)
//   miss                 → continue the ray into cascade i+1: 8 surrounding
//                          parent probes (trilinear) × the ray's 4 angular
//                          child directions, averaged.
//
// Spatial weighting adapts the reference's WeightedSample visibility proxy
// from its surfel/tangent-frame form to full 3D: each parent probe's stored
// hit distance in the direction toward the child probe is treated as an
// occlusion proxy — if the parent's own ray that way hit something closer
// than the child, that parent is behind a wall and its weight is zeroed.
// Approximate on purpose (a parent's annular interval doesn't cover its own
// near field), same spirit as the reference's "flatland assumption" note.
import { Fn, If, Loop, float, floor, instanceIndex, instancedArray, max, mod, vec3, vec4 } from "three/tsl";
import { octahedralTexelIndex } from "./cascadeTrace.js";

/**
 * Builds merged-result buffers + merge computes for a cascade array made by
 * createRadianceCascades. Returns `mergeComputes` already ordered coarse →
 * fine (dispatch them in that order, after all trace computes).
 *
 * @param {Array} cascades from createRadianceCascades
 * @param {object} [opts]
 * @param {[number, number, number]} [opts.sky] radiance for rays that escape
 *   the outermost cascade. Default black — the spike's sealed-room checks
 *   depend on escapes contributing nothing.
 */
export function createCascadeMerge(cascades, { sky = [0, 0, 0] } = {}) {
  for (const cascade of cascades) {
    cascade.merged = instancedArray(cascade.probeCount * cascade.dirCount, "vec4");
    cascade.mergedAverages = instancedArray(cascade.probeCount, "vec3");
  }

  const mergeComputes = [];

  for (let level = cascades.length - 1; level >= 0; level--) {
    const cascade = cascades[level];
    const parent = cascades[level + 1] ?? null;
    const { dirCount, dirRes, probeCount, rays, merged } = cascade;

    const merge = Fn(() => {
      const own = rays.element(instanceIndex).toVar();
      const out = vec4(0, 0, 0, -1).toVar();

      If(own.w.greaterThan(0), () => {
        out.assign(own);
      }).Else(() => {
        if (!parent) {
          out.assign(vec4(sky[0], sky[1], sky[2], -1));
        } else {
          const rayIdx = instanceIndex.toFloat();
          const probeIdx = floor(rayIdx.div(dirCount));
          const dirIdx = mod(rayIdx, dirCount);
          const childPos = cascade.probePositionOf(probeIdx).toVar();

          // The ray's 4 angular children in the parent's (finer-angular)
          // octahedral tile: texel (u,v)@R subdivides into the 2x2 block at
          // (2u, 2v)@2R.
          const u = mod(dirIdx, dirRes);
          const v = floor(dirIdx.div(dirRes));
          const parentDirBase = v.mul(2).mul(parent.dirRes).add(u.mul(2));

          // Continuous coords of the child position in the parent's
          // cell-centered lattice.
          const bounds = cascade.bounds;
          const cellX = (bounds.max.x - bounds.min.x) / parent.grid.x;
          const cellY = (bounds.max.y - bounds.min.y) / parent.grid.y;
          const cellZ = (bounds.max.z - bounds.min.z) / parent.grid.z;
          const fcX = childPos.x.sub(bounds.min.x).div(cellX).sub(0.5);
          const fcY = childPos.y.sub(bounds.min.y).div(cellY).sub(0.5);
          const fcZ = childPos.z.sub(bounds.min.z).div(cellZ).sub(0.5);
          const baseX = floor(fcX).toVar();
          const baseY = floor(fcY).toVar();
          const baseZ = floor(fcZ).toVar();
          const fracX = fcX.sub(baseX);
          const fracY = fcY.sub(baseY);
          const fracZ = fcZ.sub(baseZ);

          const acc = vec3(0).toVar();
          const weightSum = float(0).toVar();

          Loop({ start: 0, end: 8, name: "corner" }, ({ corner }) => {
            const cf = corner.toFloat();
            const bx = mod(cf, 2);
            const by = mod(floor(cf.div(2)), 2);
            const bz = floor(cf.div(4));
            const px = baseX.add(bx).clamp(0, parent.grid.x - 1);
            const py = baseY.add(by).clamp(0, parent.grid.y - 1);
            const pz = baseZ.add(bz).clamp(0, parent.grid.z - 1);
            const parentProbeIdx = pz.mul(parent.grid.y).add(py).mul(parent.grid.x).add(px).toVar();
            const parentPos = parent.probePositionOf(parentProbeIdx).toVar();

            const wx = mod(bx.add(1), 2).mul(fracX.oneMinus()).add(bx.mul(fracX));
            const wy = mod(by.add(1), 2).mul(fracY.oneMinus()).add(by.mul(fracY));
            const wz = mod(bz.add(1), 2).mul(fracZ.oneMinus()).add(bz.mul(fracZ));
            const weight = wx.mul(wy).mul(wz).toVar();

            // Visibility proxy: the parent's own ray toward the child.
            const rel = childPos.sub(parentPos).toVar();
            const dist = rel.length().toVar();
            If(dist.greaterThan(1e-4), () => {
              const towardChild = octahedralTexelIndex(rel.div(dist), parent.dirRes);
              const parentRay = parent.rays.element(
                parentProbeIdx.mul(parent.dirCount).add(towardChild).toInt(),
              );
              If(parentRay.w.greaterThanEqual(0).and(parentRay.w.lessThan(dist.sub(0.01))), () => {
                weight.assign(0);
              });
            });

            // Mean of the 4 angular children from the parent's MERGED field
            // (same-frame data — the parent merge already ran this submit).
            const rowBase = parentProbeIdx.mul(parent.dirCount).add(parentDirBase);
            const s0 = parent.merged.element(rowBase.toInt()).xyz;
            const s1 = parent.merged.element(rowBase.add(1).toInt()).xyz;
            const s2 = parent.merged.element(rowBase.add(parent.dirRes).toInt()).xyz;
            const s3 = parent.merged.element(rowBase.add(parent.dirRes).add(1).toInt()).xyz;
            const parentRad = s0.add(s1).add(s2).add(s3).mul(0.25);

            acc.addAssign(parentRad.mul(weight));
            weightSum.addAssign(weight);
          });

          out.assign(vec4(acc.div(max(weightSum, 1e-3)), -1));
        }
      });

      merged.element(instanceIndex).assign(out);
    })().compute(probeCount * dirCount);

    const average = Fn(() => {
      const sum = vec3(0).toVar();
      const base = instanceIndex.toInt().mul(dirCount);
      Loop({ start: 0, end: dirCount, name: "d" }, ({ d }) => {
        sum.addAssign(merged.element(base.add(d)).xyz);
      });
      cascade.mergedAverages.element(instanceIndex).assign(sum.div(dirCount));
    })().compute(probeCount);

    mergeComputes.push(merge, average);
  }

  return { mergeComputes };
}
