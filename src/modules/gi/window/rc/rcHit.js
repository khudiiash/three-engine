// §19 STAGE 5.3 — THE HIT RADIANCE, AND WHERE THE SECOND BOUNCE ACTUALLY LIVES
//
// ⭐⭐⭐ THE ONE-SENTENCE VERSION: a ray hit is worth
//
//     L(H) = Le(H) + ρ(H)/π · [ direct(H) + E_rc(H, n̂) ]
//
// where `direct` is a sun shadow ray plus emitter NEE under the ONE admission
// gate — CACHED PER VOXEL FACE, on the cadence it always ran on — and `E_rc` is
// the MERGED CASCADE FIELD read at the hit point against the hit face's normal.
// That second term is the paper's secondary probe cache, realised on the same
// lattices the primary gather reads, through the same eight-probe visibility-
// weighted `gatherAt` a pixel resolves with.
//
// ══ WHY THIS IS A STRUCTURAL CHANGE AND NOT A BETTER ESTIMATOR ══════════════
//
// 5.2 shipped the picture but not the energy: gain 0.66× on the user's Cornell
// box, and the commit named the residual before it measured it — "hits are
// still lit by the old cache face". That face carried its own four cosine sky
// rays whose hits read NEIGHBOURING CACHE FACES, each of which was a four-ray
// estimate of the same kind. §AL priced it: a face whose OFFLINE quadrature has
// σ 17.6 % reads σ 51.9 % on the GPU, because the error compounds through the
// cache at ~1/(1−ρ) and the user's walls are authored at ρ = 1.0. Two fixed
// points, and §AK.6 measured the gate landing on either one across identical
// boots (black census ~690 vs ~8600).
//
// Direct-only removes the loop rather than damping it. The cache is now a pure
// function of the lights and the geometry — it CANNOT be an input to itself, at
// any albedo, in any scene — and the only remaining loop is the one radiance
// cascades are: probes → hits → probes, whose gain is the albedo, whose state
// is the α-accumulated bin, and whose fixed point is unique because the field
// it passes through is smooth, merged and cone-averaged.
//
// ══ WHY SKY IS NOT HERE, AND SAYING WHICH TERM CARRIES IT ═══════════════════
//
// ⚠ THE MERGED FIELD ALREADY CARRIES THE SKY, AT THE TOP CASCADE AND EXACTLY
// ONCE. `rcMerge` hands `srcMerge` the gather's own `u.skyColor` and the top
// cascade's composite is where an unoccluded direction picks it up; a MISS in
// the deposit lands past every cascade (`own == N`), which deposits `(0, T = 1)`
// and no radiance, so the trace never introduces a second copy. `E_rc(H)` is
// therefore already "bounce + sky as seen from H", and the four cosine sky rays
// `shadeTerms` used to fire at H would be that same light a second time. They
// are gone — `createGiGather`'s `rc5` flag drops `seedU`, which is the single
// switch that removes the block from the WGSL as well as from the sum.
//
// ⚠ AND `injectLitFrame` IS GONE FOR THE SAME REASON, not as an optimisation:
// it EMAs a visible pixel's FINAL diffuse colour into its own voxel face, which
// is `ρ/π · E_total + Le`. There is no way to subtract the bounce back out of
// it, so under `rc5` the pass is not built at all.
//
// ══ THE 8-STORAGE-BUFFER LIMIT IS WHY THIS IS A PASS AND NOT A LINE ═════════
//
// 5.1's deposit kernel binds EIGHT of the portable eight: `scratch`, `stats`,
// `probeTable`, `pixelProbe`, `pixelRayBase`, `rayWork`, the window's bits and
// the radiance cache. `gatherAt` costs one more (`hashKeys`, keys and the block
// tail in one buffer — that single-buffer lookup is exactly what
// `createSrcHashBlockFrame` exists for), and nine does not compile on the
// portable tier.
//
// So the shading moves OFF the deposit, onto the hit list `srcDeposit` has
// carried since §12.53 and `srcSecondary.js` has read since — the same split,
// for the same reason, on the new transport:
//
//     [E] deposit   traces, ATTRIBUTES, appends       7 buffers (cache dropped)
//     [J] this      shades + gathers + deposits R/G/B 5 buffers
//
// and it is cheaper as well as portable: ~76 % of rays miss, and a miss never
// reaches the append, so the shading is paid on hits alone. 5.1's deposit was
// 3.18 ms of trace + the FULL old `shadeHit` (1 sun + 4 sky + 4 NEE rays per
// fresh face) + 2.46 scatters/ray.
//
// ══ THE RECORD CARRIES THE CACHE ADDRESS IN `SEC_RAY`, AND THAT IS DELIBERATE
//
// [J] needs (level, voxel, face) to read and accumulate the face cache. That is
// one u32. `SEC_RAY` is a raw u32 word whose only consumer is `srcShade`'s
// stratified NEE draw — and this path has no draw to stratify (its direct
// estimator is a COMPLETE FIXED SET: one sun ray, every emitter slot), so the
// word is free. `srcDeposit` writes `attribute`'s `ray` when one is returned
// and `n` when one is not, which keeps the old path's record byte-identical and
// keeps `SECONDARY_HIT_WORDS` at 16.
//
// ══ COVERAGE RIDES IN ρ, WHICH IS THE ONLY PLACE IT CAN RIDE ════════════════
//
// §AG's throughput `T` is the fraction of the ray that survived the thin voxels
// it met, and it must attenuate BOTH halves of the hit's radiance. `srcSecondary`
// computes its bounce half as `ρ · E_atlas / π` from the record's ρ, so folding
// `T` into ρ scales that half exactly; this file's `shade` closure applies the
// same `T` to the cached direct half. One number, one meaning, both terms — and
// `T` is exactly 1 in a scene with no cables, railings or foliage in it, where
// this whole paragraph is a provable no-op.
import { If, bitAnd, dot, float, shiftLeft, shiftRight, sqrt, uint, vec3 } from "three/tsl";
import { normalOfFace } from "../radianceCache.js";

/**
 * The face-cache address as one u32: the DDA's own packed word with its entry
 * face replaced by the DOMINANT face.
 *
 * ⭐ THE DOMINANT FACE, NOT THE RAY'S ENTRY FACE — §19 3.9's rule, and the same
 * one `rcShade` and `hitRadiance` follow. A ray that reads the face it entered
 * through samples a word no other ray fills and hands back a systematic zero.
 */
export const packAddr = (zi, faceF) =>
  shiftLeft(shiftRight(zi, uint(3)), uint(3)).add(faceF.toUint());

/** `packAddr`'s inverse, in the three floats every window closure takes. */
export const unpackAddr = (a) => ({
  faceF: bitAnd(a, uint(7)).toFloat(),
  levelF: bitAnd(shiftRight(a, uint(3)), uint(7)).toFloat(),
  voxF: shiftRight(a, uint(6)).toFloat(),
});

/**
 * The two closures [E] and [J] are split across.
 *
 * @param {object} o
 * @param {object} o.cache  `createRadianceCache`'s — read and accumulated by
 *   [J] alone now. [E] does not bind it, which is the binding this stage buys.
 * @param {object} o.kit  the gather's published closures (`u`, `dominantFace`,
 *   `faceSamplePoint`, `shadeHit`, `hitPalette`). ⚠ PASSED, NOT REBUILT: a
 *   second transcription of `shadeHit` cost 2.5 s of pipeline compile at 3.5.
 * @param {object} [o.counters]  `createSrcShadeCounters(bins)` — the tally the
 *   deposit's own receipt reads as "NO HIT SHADING" when it is missing.
 */
export function createRcHitShading({ cache, kit, counters = null }) {
  const { u, dominantFace, faceSamplePoint, shadeHit, hitPalette } = kit;
  if (typeof hitPalette !== "function") {
    throw new Error(
      "createRcHitShading: the gather must publish `hitPalette` — [J] multiplies the cascade " +
      "field by the hit's ρ and adds it to a cache word `shadeHit` wrote, and two transcriptions " +
      "of that albedo are two chances for the halves to disagree about which surface they are on",
    );
  }

  /**
   * [E]'s half: what a hit IS, with no light in it at all.
   *
   * Runs for every ray, hit or miss, exactly as the inline shader did — a miss
   * leaves `slot` EMPTY in `srcDeposit` and falls out of the append with no
   * test of its own.
   */
  const attribute = (r, dir) => {
    const zi = r.raw.z.toUint().toVar();
    const P = vec3(0).toVar();
    const N = vec3(0).toVar();
    const rho = vec3(0).toVar();
    const Le = vec3(0).toVar();
    const addr = uint(0).toVar();
    // §AG's coverage, carried through ρ — see the header. Held as its own word
    // too, because [J]'s direct half needs it and ρ is already spoken for.
    const T = float(r.throughput).toVar();
    If(r.raw.x.greaterThan(0.5), () => {
      const entryF = bitAnd(zi, uint(7)).toFloat().toVar();
      const levelF = bitAnd(shiftRight(zi, uint(3)), uint(7)).toFloat().toVar();
      const voxF = shiftRight(zi, uint(6)).toFloat().toVar();
      const faceF = dominantFace(levelF, voxF, entryF, dir.negate()).toVar();
      const hn = normalOfFace(faceF).toVar();
      N.assign(hn);
      // ⭐ THE SHADE POINT BELONGS TO THE SLOT, NOT TO THE RAY (§19 3.9): the
      // voxel's face plane, so every ray reaching this face shades the same
      // point and re-shading is idempotent.
      P.assign(faceSamplePoint(levelF, voxF, hn));
      const pal = hitPalette(levelF, voxF);
      rho.assign(pal.rho.mul(T));
      Le.assign(pal.Le);
      addr.assign(packAddr(zi, faceF));
    });
    // ⚠ `emitter` CARRIES `T`, and the record has no spare word for it. That
    // slot's own meaning (R5's "< 0 = not an NEE light") belongs to the old
    // path's emitter-zeroing, which this transport does not do — the admission
    // gate has already zeroed a seated class's `palEm` on the CPU. So the word
    // is free, `srcSecondary` hands it to `shade` as its fifth argument, and
    // both halves of the hit's radiance are attenuated by the same coverage.
    return { P, n: N, rho, emissive: Le, ray: addr, emitter: T };
  };

  /**
   * [J]'s DIRECT half: the face cache, read; shaded and accumulated where the
   * word is fresh.
   *
   * ⚠ THE CACHE STORES THE FACE'S OWN RADIANCE, NOT THE RAY'S. The accumulate
   * takes the unattenuated shade `s`; only the value handed back to the deposit
   * is multiplied by this ray's coverage. Getting that backwards would write a
   * cable's shadow into a wall's memory of the sun.
   *
   * ⭐ AND THE SHADE IS `Le + ρ/π · (sun + NEE)` — a FIXED function of the face
   * with no stochastic input anywhere in it, which is what makes the cadence a
   * latency knob instead of a noise source and what lets the EMA converge to a
   * point rather than rattle around a mean.
   */
  const shade = (P, n, rho, Le, T, addr) => {
    const { faceF, levelF, voxF } = unpackAddr(uint(addr));
    const fF = faceF.toVar();
    const lF = levelF.toVar();
    const vF = voxF.toVar();
    const L = vec3(0).toVar();
    const c = cache.cacheRead(lF, vF, fF).toVar();
    counters?.shaded(1);
    L.assign(c.xyz);
    If(c.w.lessThan(0.5), () => {
      // `seedU` is `uint(1)` and is dropped by `shadeHit` under `rc5` — see the
      // header. `.toVar()` on the accumulate is load-bearing: a call for side
      // effect alone is dead-code-eliminated.
      const s = shadeHit(P, n, lF, vF, uint(1)).toVar();
      cache.cacheAccum(lF, vF, fF, s, u.nCapU, u.cacheSmoothU).toVar();
      L.assign(s);
    });
    return { L: L.mul(T) };
  };

  return { attribute, shade };
}

/**
 * ⭐⭐⭐ §19 STAGE 5.3 — THE SEATED EMITTER'S DIRECT TERM, AT THE SHADING POINT.
 *
 * ══ THE HOLE THIS CLOSES, AND WHY NO IMAGE STATISTIC NAMED IT ══════════════
 *
 * An emitter admitted by the radiant-power gate and SEATED into one of the four
 * NEE slots has its palette emission set to EXACTLY ZERO (`GISystem`'s
 * `#gi2SlotEmissive`: `entry.promoted → [0,0,0]`). That is the ONE
 * REPRESENTATION rule and it is right — §12.26.7 measured the 2.60× double
 * count when both were on. But it has a consequence the cascades inherit
 * whole: a ray that hits the lamp reads a cache word with no emission in it, so
 * **a seated lamp is invisible to the transport**. Its light exists only in the
 * NEE term, and the NEE term is evaluated where somebody evaluates it.
 *
 * Both shipped paths evaluate it at the PROBE — `gi2System`'s
 * `emitterDirectPass` adds each slot's analytic solid angle into `probeSh` on
 * the screen path, and `worldProbes.neePass` does the identical add at every
 * lattice probe on the world path. So on both of them the lamp's DIRECT light
 * is part of `gi2.textures.irradiance`, which is the convention every gate in
 * this repository is written against.
 *
 * 5.1/5.2 shipped the cascades with NEITHER: the deposit lights a HIT from the
 * face cache (which does carry `Enee` — the second bounce of the lamp is fine),
 * and the pixel resolve reads only the merged field. The lamp's FIRST bounce
 * had no carrier at all. Measured on the user's Cornel.scene, that is the whole
 * of the 5.2/5.3 energy residual: per-surface ratios 0.21-0.73, global gain
 * 0.30×, and a black census of ZERO — the picture is complete and uniformly
 * too dark, which is exactly what a missing ADDITIVE term looks like and
 * exactly what "median |log ratio|" cannot attribute.
 *
 * ⚠ AND THE INSTRUMENT THAT SHOULD HAVE SAID SO LIED IN THE OTHER DIRECTION:
 * the gate's own `emitter slots` line prints `L[0,0,0]` for every slot, because
 * it reads `s.color ?? s.rgb` off `state.emitterSlots` and the live uniform is
 * neither. A receipt that reads zero for a light that is working is worse than
 * no receipt — the slots ARE lit, and the deficit was never about them.
 *
 * ══ WHY IT IS THE SAME EXPRESSION, NOT A SIMILAR ONE ════════════════════════
 *
 * `Ω = min(π, π·r_eff²/d²)`, one `traceWindow` shadow ray, `L·Ω·cosθ` — byte for
 * byte what `shadeTerms`' slot loop, `gi2System`'s `emitterDirectPass` and
 * `giLight.emitterDirectAt` all compute, so one lamp delivers one energy on
 * every path and a brightness difference between two of them is a bug rather
 * than a convention.
 *
 * ⚠ THE RAY STOPS SHORT OF THE LAMP'S OWN BODY (`r_eff` plus half a level-0
 * cell). The lamp's geometry is voxelized; a ray run to the full distance is
 * occluded by the very light it is sampling and writes black — the failure the
 * panel block's own header spends a page on.
 *
 * @param {Array<object>} emitters  GISystem's slot uniforms. Empty or absent →
 *   `null`, and NOT ONE NODE of this is built (the arm every pre-5.3 receipt
 *   was taken on).
 */
export function createRcDirectAt({ trace, voxel0, emitters }) {
  if (!emitters?.length) return null;
  const { traceWindow } = trace;
  const v0 = voxel0;
  return (P, n) => {
    const E = vec3(0).toVar();
    for (const slot of emitters) {
      const centre = vec3(slot.center).toVar();
      const reff = float(slot.reff).max(1e-3).toVar();
      const rgb = vec3(slot.color).toVar();
      // `radius` is the bounding sphere and doubles as the ACTIVE gate —
      // `#refreshEmitterSlots` zeroes a retired slot's radius.
      const active = float(slot.radius).greaterThan(1e-5)
        .and(rgb.x.add(rgb.y).add(rgb.z).greaterThan(1e-6));
      If(active, () => {
        const wv = centre.sub(P).toVar();
        const d2 = dot(wv, wv).max(1e-4).toVar();
        const d = sqrt(d2).toVar();
        const wd = wv.div(d).toVar();
        const cosX = dot(n, wd).toVar();
        If(cosX.greaterThan(1e-3), () => {
          const omega = float(Math.PI).min(float(Math.PI).mul(reff.mul(reff)).div(d2)).toVar();
          const reach = d.sub(reff).sub(float(v0 * 0.5)).max(v0 * 0.5).toVar();
          const vis = float(1).sub(traceWindow(P, wd, reach, n).hit).toVar();
          E.addAssign(rgb.mul(omega).mul(cosX).mul(vis));
        });
      });
    }
    return E;
  };
}
