// 3D Radiance Cascades — final gather (Phase 4).
//
// Turns the merged c0 field into per-surface irradiance:
//   E(P, N) ≈ Σ_probes w_probe · Σ_dirs L_merged(dir) · max(dot(dir, N), 0) · Δω
// over the 8 c0 probes surrounding P (trilinear), Δω = 4π / dirCount.
// Diffuse response is then albedo · E / π at the material.
//
// The probe weighting reuses the SAME distance-visibility proxy as the
// merge (cascadeMerge.js): a probe whose own c0 ray toward P records a hit
// closer than |P − probe| is behind a surface relative to P — rejected.
// This is what keeps buried/behind-wall probes (visible as dark gizmos in
// the Phase 3 screenshots) from bleeding darkness or wrong-side light onto
// receivers. c0's interval starts at t = 0, so the proxy has no near-field
// blind zone at gather range (unlike the inter-cascade case).
//
// IMPORTANT (plan constraint): this is THE sampling implementation — the
// debug gizmos and any screen-space/deferred variant must call this same
// function, so a live-editor discrepancy can only implicate glue, not a
// second transport implementation. Direct material shading here deliberately
// bypasses any G-buffer/deferred-resolve layer (where the prior attempt's
// never-root-caused stripe bug lived).
import { Fn, If, Loop, Return, float, floor, instanceIndex, max, mod, smoothstep, step, vec3, vec4 } from "three/tsl";
import { octahedralTexelIndex, octahedralUV } from "./cascadeTrace.js";

/**
 * @param {Array} cascades from createRadianceCascades (uses cascades[0])
 * @returns {(P, N) => vec3} TSL irradiance sampler
 */
export function createIrradianceGather(cascades) {
  const c0 = cascades[0];
  const { bounds, grid, dirCount, dirRes } = c0;
  const cellX = (bounds.max.x - bounds.min.x) / grid.x;
  const cellY = (bounds.max.y - bounds.min.y) / grid.y;
  const cellZ = (bounds.max.z - bounds.min.z) / grid.z;
  // Visibility tolerance must absorb voxel quantization: a probe ray toward
  // a receiver ON a surface legitimately records its hit up to ~a voxel
  // diagonal early. A tolerance tighter than that rejects valid probes in
  // disc-shaped zones around each probe (scallop artifacts all over walls).
  const visTolerance = 1.75 * Math.max(cellX, cellY, cellZ);

  return Fn(([P, N]) => {
    const fcX = P.x.sub(bounds.min.x).div(cellX).sub(0.5);
    const fcY = P.y.sub(bounds.min.y).div(cellY).sub(0.5);
    const fcZ = P.z.sub(bounds.min.z).div(cellZ).sub(0.5);
    const baseX = floor(fcX).toVar();
    const baseY = floor(fcY).toVar();
    const baseZ = floor(fcZ).toVar();
    const fracX = fcX.sub(baseX);
    const fracY = fcY.sub(baseY);
    const fracZ = fcZ.sub(baseZ);

    const acc = vec3(0).toVar();
    const cosAcc = float(0).toVar();

    Loop({ start: 0, end: 8, name: "corner" }, ({ corner }) => {
      const cf = corner.toFloat();
      const bx = cf.mod(2);
      const by = floor(cf.div(2)).mod(2);
      const bz = floor(cf.div(4));
      const px = baseX.add(bx).clamp(0, grid.x - 1);
      const py = baseY.add(by).clamp(0, grid.y - 1);
      const pz = baseZ.add(bz).clamp(0, grid.z - 1);
      const probeIdx = pz.mul(grid.y).add(py).mul(grid.x).add(px).toVar();
      const probePos = c0.probePositionOf(probeIdx).toVar();

      const wx = bx.add(1).mod(2).mul(fracX.oneMinus()).add(bx.mul(fracX));
      const wy = by.add(1).mod(2).mul(fracY.oneMinus()).add(by.mul(fracY));
      const wz = bz.add(1).mod(2).mul(fracZ.oneMinus()).add(bz.mul(fracZ));
      const weight = wx.mul(wy).mul(wz).toVar();

      // Distance-visibility proxy: the probe's own raw c0 ray toward P.
      const rel = P.sub(probePos).toVar();
      const dist = rel.length().toVar();
      If(dist.greaterThan(1e-4), () => {
        const towardP = octahedralTexelIndex(rel.div(dist), dirRes);
        const probeRay = c0.rays.element(probeIdx.mul(dirCount).add(towardP).toInt());
        // Soft rejection: fade the probe out over [tol, 2·tol] of blocker
        // penetration instead of a binary cut — the hard zero produced
        // visible blotch/scallop boundaries where the rejection state
        // flipped between neighboring receivers.
        If(probeRay.w.greaterThanEqual(0), () => {
          const penetration = dist.sub(probeRay.w);
          weight.mulAssign(smoothstep(visTolerance, visTolerance * 2, penetration).oneMinus());
        });
      });

      // Cosine-weighted radiance sum + cosine total for this probe.
      const probeE = vec3(0).toVar();
      const probeCos = float(0).toVar();
      const rowBase = probeIdx.mul(dirCount).toVar();
      Loop({ start: 0, end: dirCount, name: "d" }, ({ d }) => {
        const dir = c0.directionOf(d.toFloat());
        const cosTheta = max(dir.dot(N), 0);
        probeE.addAssign(c0.merged.element(rowBase.add(d).toInt()).xyz.mul(cosTheta));
        probeCos.addAssign(cosTheta);
      });

      acc.addAssign(probeE.mul(weight));
      cosAcc.addAssign(probeCos.mul(weight));
    });

    // E = π · (Σ L·cos / Σ cos): the cosine-weighted AVERAGE radiance times
    // π. Exact for uniform L at any direction count — unlike the naive
    // Σ L·cos·Δω Riemann sum, which overestimates with few directions and
    // drove the bounce-feedback loop's gain above 1 (divergent white-out in
    // enclosed rooms at c0DirRes 2, whose 4 directions are all equatorial).
    // Bounded: E ≤ π·max(L), so feedback gain ≤ albedo < 1, always
    // convergent. All-probes-rejected / degenerate-cos → 0/ε → black.
    return acc.div(max(cosAcc, 1e-3)).mul(Math.PI);
  });
}

/**
 * Directional radiance lookup for GLOSSY REFLECTIONS: samples the merged
 * field of one cascade along a single direction (the reflection vector),
 * trilinear over 8 probes. Cascade level trades angular sharpness against
 * spatial accuracy (higher level = finer direction bins, sparser probes) —
 * level 2 gives ~11° bins at c0DirRes 4, a soft glossy look. Mirror-sharp
 * reflections are SSR's job (engine module); this is the everything-else
 * fallback the reference demo hard-codes analytically.
 */
export function createRadianceLookup(cascades, level = 2) {
  const c = cascades[Math.min(level, cascades.length - 1)];
  const { bounds, grid, dirRes, dirCount } = c;
  const cellX = (bounds.max.x - bounds.min.x) / grid.x;
  const cellY = (bounds.max.y - bounds.min.y) / grid.y;
  const cellZ = (bounds.max.z - bounds.min.z) / grid.z;

  return Fn(([P, R]) => {
    const fcX = P.x.sub(bounds.min.x).div(cellX).sub(0.5);
    const fcY = P.y.sub(bounds.min.y).div(cellY).sub(0.5);
    const fcZ = P.z.sub(bounds.min.z).div(cellZ).sub(0.5);
    const baseX = floor(fcX).toVar();
    const baseY = floor(fcY).toVar();
    const baseZ = floor(fcZ).toVar();
    const fracX = fcX.sub(baseX);
    const fracY = fcY.sub(baseY);
    const fracZ = fcZ.sub(baseZ);

    // Bilinear across DIRECTION texels as well as probes: nearest-texel
    // sampling showed the octahedral bins as hard triangular facets on
    // glossy surfaces. (Fold seams are clamped, not wrapped — residual seam
    // error is far below the facets this removes.)
    const octa = octahedralUV(R, dirRes);
    const du = octa.u.sub(0.5);
    const dv = octa.v.sub(0.5);
    const du0 = floor(du).clamp(0, dirRes - 1).toVar();
    const dv0 = floor(dv).clamp(0, dirRes - 1).toVar();
    const du1 = du0.add(1).clamp(0, dirRes - 1).toVar();
    const dv1 = dv0.add(1).clamp(0, dirRes - 1).toVar();
    const fu = du.sub(floor(du)).clamp(0, 1);
    const fv = dv.sub(floor(dv)).clamp(0, 1);

    const acc = vec3(0).toVar();
    Loop({ start: 0, end: 8, name: "corner" }, ({ corner }) => {
      const cf = corner.toFloat();
      const bx = cf.mod(2);
      const by = floor(cf.div(2)).mod(2);
      const bz = floor(cf.div(4));
      const px = baseX.add(bx).clamp(0, grid.x - 1);
      const py = baseY.add(by).clamp(0, grid.y - 1);
      const pz = baseZ.add(bz).clamp(0, grid.z - 1);
      const probeIdx = pz.mul(grid.y).add(py).mul(grid.x).add(px);
      const wx = bx.add(1).mod(2).mul(fracX.oneMinus()).add(bx.mul(fracX));
      const wy = by.add(1).mod(2).mul(fracY.oneMinus()).add(by.mul(fracY));
      const wz = bz.add(1).mod(2).mul(fracZ.oneMinus()).add(bz.mul(fracZ));
      const weight = wx.mul(wy).mul(wz);
      const rowBase = probeIdx.mul(dirCount);
      const s00 = c.merged.element(rowBase.add(dv0.mul(dirRes)).add(du0).toInt()).xyz;
      const s10 = c.merged.element(rowBase.add(dv0.mul(dirRes)).add(du1).toInt()).xyz;
      const s01 = c.merged.element(rowBase.add(dv1.mul(dirRes)).add(du0).toInt()).xyz;
      const s11 = c.merged.element(rowBase.add(dv1.mul(dirRes)).add(du1).toInt()).xyz;
      const filtered = s00
        .mul(fu.oneMinus().mul(fv.oneMinus()))
        .add(s10.mul(fu.mul(fv.oneMinus())))
        .add(s01.mul(fu.oneMinus().mul(fv)))
        .add(s11.mul(fu.mul(fv)));
      acc.addAssign(filtered.mul(weight));
    });
    return acc;
  });
}

/**
 * Multi-bounce feedback (plan §3.4): per occupied voxel, gather the merged
 * c0 irradiance at the cell and write `base + albedo · E/π · gain` into the
 * LIVE radiance buffer the cascade trace reads. This is the pass that makes
 * an emissive-only Cornell box bleed: without it, surfaces lit purely by GI
 * have black voxels and reflect nothing (bounce 2+ never enters the field).
 *
 * It is a feedback loop across frames (reads last frame's merged field),
 * but it carries only the secondary energy — gain is fixed and < the
 * scene's albedo ceiling, so it converges geometrically in a few frames
 * with no hysteresis or lag heuristics. Junction cells (low normal
 * reliability, stored in surface.w) get no feedback — their normal is
 * garbage — mirroring the direct-bake gate.
 *
 * Dispatch this FIRST in the per-frame queue (before traces/merges).
 */
export function createBounceFeedback(cascades, volume, gainUniform) {
  const gather = createIrradianceGather(cascades);
  const { res, bounds, cell } = volume;
  const cellCount = res.x * res.y * res.z;
  const normalLift = Math.min(cell.x, cell.y, cell.z) * 1.2;

  return Fn(() => {
    const base = volume.baseBuffer.element(instanceIndex).toVar();
    If(base.w.lessThan(0.5), () => {
      Return();
    });
    const surface = volume.surfaceBuffer.element(instanceIndex).toVar();
    const out = vec4(base.xyz, 1).toVar();
    // Reliability gate matches the CPU direct bake's 0.35 threshold.
    If(surface.w.greaterThan(0.35), () => {
      const idx = instanceIndex.toFloat();
      const ix = mod(idx, res.x);
      const iy = mod(floor(idx.div(res.x)), res.y);
      const iz = floor(idx.div(res.x * res.y));
      const normal = volume.normalBuffer.element(instanceIndex).xyz;
      const cellCenter = vec3(
        ix.add(0.5).mul(cell.x).add(bounds.min.x),
        iy.add(0.5).mul(cell.y).add(bounds.min.y),
        iz.add(0.5).mul(cell.z).add(bounds.min.z),
      );
      // Thin geometry has arbitrary normal facing (see the bake's |ndotl|
      // note): gather BOTH sides and keep the brighter hemisphere, so a
      // wall plane facing "out" of a lit room still re-radiates the room's
      // light. max(0)/min: WGSL min/max return the non-NaN operand, so this
      // also scrubs NaN before it can recirculate through the feedback loop.
      const front = gather(cellCenter.add(normal.mul(normalLift)), normal).max(vec3(0)).min(vec3(1e4));
      const back = gather(cellCenter.sub(normal.mul(normalLift)), normal.negate()).max(vec3(0)).min(vec3(1e4));
      const frontLum = front.dot(vec3(0.2126, 0.7152, 0.0722));
      const backLum = back.dot(vec3(0.2126, 0.7152, 0.0722));
      const irradiance = front.mul(step(backLum, frontLum)).add(back.mul(step(backLum, frontLum).oneMinus()));
      // Albedo clamped to 0.9: a pure-white (albedo 1.0) enclosed room makes
      // the feedback series diverge even at gain 1 — real surfaces never
      // reflect 100%, and the clamp guarantees loop gain ≤ 0.9·gainUniform.
      const albedo = surface.xyz.min(vec3(0.9));
      out.assign(vec4(base.xyz.add(albedo.mul(irradiance).div(Math.PI).mul(gainUniform)), 1));
    });
    volume.radianceBuffer.element(instanceIndex).assign(out);
  })().compute(cellCount);
}
