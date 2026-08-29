// §19 STAGE 5.1 — WHAT THE PORT CHANGES, AND IT IS ONLY THE POOLS
//
// ⭐⭐⭐ THIS FILE DEFINES NO GEOMETRY, NO DIRECTIONS AND NO INTERVALS. The
// Radiance Cascades contract already exists in this repository, written against
// the paper and gated by a CPU mirror: `srcConfig.js` (β = 4, γ = 4, four
// cascades, W0 = 4 → 32 directions at c0 branching ×4, r0/s0 = 1.6, LOD overlap
// 0.9, TEMPORAL_ALPHA 0.1), `srcMath.js`/`srcMathTsl.js` (the equal-area bins,
// `binParent`/`binChildren`, Morton, R2), `srcOctahedral.js`, `srcMerge.js`
// (the eight-corner cone merge), `srcDeposit.js` (the R/G/B/T/COUNT bin words
// and Algorithm 3's split deposit) and `srcProbes.js` (hashed sparse probes
// with LOD, age and parents).
//
// The old path did not fail on that math. It failed on SCALE — an occupancy
// field and a BVH8 hit-shading wave sized by the scene (Bistro: 491 MB of
// occupancy bits, a 155 s compile wave, 6 fps). So Stage 5.1 is a PORT, not a
// rewrite: keep the cascade core, replace the TRANSPORT with GI2's window
// bit-DDA (`traceWindow`, coverage throughput T) and its hit radiance, and
// BOUND THE POOLS BY TIER instead of by the scene.
//
// What lives here is therefore exactly the second half of that sentence: how
// many probes, how many bins and how many rays a device may spend, plus the
// census helpers that read the contract out of `srcConfig` so a receipt and the
// kernels cannot disagree about where a cascade's band starts.
import {
  CASCADE_COUNT, MAX_LODS, PROBE_RAY_CAP_OFF, TEMPORAL_ALPHA, W0, cascadeReach, intervalBoundaries, intervalLength,
  probeSpacing,
} from "../../srcConfig.js";

export { CASCADE_COUNT, MAX_LODS, PROBE_RAY_CAP_OFF, TEMPORAL_ALPHA, W0 };

/**
 * The per-tier envelope.
 *
 * `c0Probes` and `binBudget` are the two allocations §19's scale audit named:
 * the probe hash and the bin block pool. `SRC_POOL_FLOORS` (16 384 / 700 000)
 * is the shipped floor of the old system and is kept as the desktop value — the
 * trap was never the floor, it was `expectedC0Probes(pixelCount)` growing them
 * with the viewport until a 4 K editor asked for 131 072 c0 slots to hold 1 788
 * live probes.
 *
 * `rays` is the frame's ray ceiling. The deposit dispatches `threads` rays with
 * a per-frame phase, so a scene with more pixels than budget is covered over
 * `stride` frames rather than traced twice — `srcRays`' own mechanism, driven
 * from here instead of from `srcConfig.srcTransportRays`, because a GI2 tier is
 * the thing that knows what a device can pay.
 *
 * `spacing0` is Δs₀. `lods` caps the LOD ladder: LOD `l` doubles the spacing
 * and the interval, so `lods` is the far reach — 4 LODs at 0.5 m reach 4× the
 * c0 chain, and beyond it there is no probe and the sky answers.
 */
export const RC_TIERS = {
  ultra: { spacing0: 0.5, c0Probes: 16384, binBudget: 700_000, rays: 1_100_000, lods: 5, lmax: 16, hitList: 600_000, probeRayCap: 16 },
  high: { spacing0: 0.5, c0Probes: 16384, binBudget: 700_000, rays: 900_000, lods: 5, lmax: 16, hitList: 500_000, probeRayCap: 16 },
  medium: { spacing0: 0.5, c0Probes: 8192, binBudget: 350_000, rays: 450_000, lods: 4, lmax: 16, hitList: 250_000, probeRayCap: 16 },
  phone: { spacing0: 1.0, c0Probes: 4096, binBudget: 175_000, rays: 200_000, lods: 3, lmax: 16, hitList: 120_000, probeRayCap: 16 },
};

/**
 * ⭐⭐ §19 6.19 — THE RAY BUDGET IS PER c0 PROBE, NOT PER PIXEL.
 *
 * `rays` above is a DISPATCH ceiling, and every thread under it whose pixel
 * is lit fires one ray — so the number of rays traced, the number of hits
 * appended and (the owner, measured) the number of hit records [J] shades
 * all grew with LIT-PIXEL COVERAGE: Cornell inside the box at 452k px shaded
 * 3.90 ms of [J] against 0.60 ms outside, on 74 triangles. The plan's
 * contract is a fixed budget. Algorithm 3 already carries one — the per-probe
 * cap [D1'] that `srcSystem` shipped at 16/32 — and GI2's RC path simply
 * never passed it. With W0 = 4 a c0 probe owns 16 bins, so 16 rays per probe
 * per frame is one ray per bin per frame; the deposit's α = 0.1 accumulator
 * converges on the same mean from fewer samples per frame, only later.
 *
 * `__gi2ProbeRayCap`: a positive number overrides the tier's cap; `0` turns it
 * OFF (`PROBE_RAY_CAP_OFF`, the pre-6.19 per-pixel arm — the A/B this shipped
 * against). Polled per frame by `beginFrame` (a uniform, never a rebuild).
 */
/**
 * §19 6.19b — the bin accumulator's age-aware window in samples (see
 * `srcDeposit`'s `window`). 64: a settled bin at one ray per frame averages
 * 64 frames (α_floor 1/65 ≈ 0.015), and a bin below 64 samples is a running
 * mean. `__gi2BinWindow`: a positive number overrides; `0` restores the fixed
 * `TEMPORAL_ALPHA` decay (the 6.19 arm this shipped against).
 */
//
// ⛔ SHIPPED OFF (0). Measured 6.19b at 64 on Cornell: the inside shot blew
// out to white and the gate read 13 black px / median 0.325 / at-rest p90
// 11.8 % — a bin held at k = 1 below 64 samples is being NORMALISED by
// something that assumes the EMA's steady-state count (the resolve or [J]'s
// SR/SG/SB words), not by COUNT. Find that reader before re-defaulting;
// `__gi2BinWindow = 64` arms the arm for the A/B.
export const BIN_WINDOW = 0;
export const rcBinWindow = (runtime = globalThis) => {
  const forced = Number(runtime?.__gi2BinWindow);
  if (Number.isFinite(forced)) return forced > 0 ? Math.round(forced) : null;
  return BIN_WINDOW;
};

export const rcProbeRayCap = (spec, runtime = globalThis) => {
  const forced = Number(runtime?.__gi2ProbeRayCap);
  if (Number.isFinite(forced)) return forced > 0 ? Math.max(1, Math.round(forced)) : PROBE_RAY_CAP_OFF;
  const cap = spec?.probeRayCap;
  return Number.isFinite(cap) && cap > 0 ? Math.round(cap) : PROBE_RAY_CAP_OFF;
};

/**
 * §19 STAGE 5.3 — [J]'s HIT LIST, AND WHY IT IS A TIER CONSTANT AND NOT THE
 * RAY COUNT.
 *
 * The exact bound is one entry per ray, which is what the old path used and
 * what makes overflow impossible. At 16 words × 4 B that is 70 MB at the ultra
 * ceiling, on top of a `scratch` buffer that already holds 700 k bins — past
 * half of WebGPU's 128 MiB `maxStorageBufferBindingSize` for a list whose
 * OCCUPANCY is the hit rate, measured at ~24 % on Bistro (§AG: ~76 % of rays
 * miss, and a miss is never appended).
 *
 * So the list is sized at roughly half the ray ceiling — comfortably above the
 * measured hit rate, comfortably under the binding limit — and `STAT_SEC_
 * OVERFLOW` is the instrument that says the bound was wrong rather than the
 * dropping being acceptable. ⚠ A SEALED SCENE IS THE STRESS CASE, not an open
 * one: in the Cornell box nearly every ray hits, and the gate's own viewport is
 * what keeps `threads` far below the ceiling there.
 */
/**
 * §19 5.3's A/B, and it is a BUILD arm because it has to be: `__gi2Rc5Hit = 0`
 * restores 5.2 exactly — the inline `shadeHit` at the deposit AND the face
 * cache's own sky rays and `injectLitFrame` writes, which are the same decision
 * seen from the gather's side (`createGiGather`'s `rc5`). Splitting them would
 * give an arm that is neither build: a direct-only cache read inline is 5.2's
 * arrangement with 5.3's estimator and half of 5.3's light.
 */
export const rcHitPathEnabled = (runtime = globalThis) => (runtime?.__gi2Rc5Hit ?? 1) !== 0;

export const rcHitCapacity = (spec, threads) =>
  Math.max(1, Math.min(Math.max(1, Math.floor(threads)), spec.hitList ?? 500_000));

export const rcTierSpec = (tier) => ({ ...(RC_TIERS[tier] ?? RC_TIERS.high) });

/**
 * THE INTERVAL CENSUS, ON THE CPU — the 5.1 gate's first line.
 *
 * For one LOD, cascade `c` owns `[t_c, t_{c+1})` with `t_0 = 0`; the last
 * cascade runs to its reach and everything past it is sky. The census asks the
 * only two questions that matter and asks them of `srcConfig`'s own numbers:
 *
 *   · GAPS — is there a distance no cascade claims? (light silently dropped)
 *   · OVERLAPS — is there a distance two cascades claim? (light counted twice)
 *
 * ⚠ AND IT IS RUN PER LOD, because the LOD ladder is the second axis: LOD `l+1`
 * doubles every boundary, and `LOD_OVERLAP = 0.9` deliberately makes the LODS
 * overlap by 10 % so the seam between them is a blend rather than an edge. That
 * overlap is BETWEEN ladders, never inside one, which is exactly what this
 * separates: `withinLod` must be clean; `lodSeam` reports the intended 0.9.
 */
export function rcIntervalCensus(spacing0, lods = MAX_LODS, cascadeCount = CASCADE_COUNT) {
  const rows = [];
  for (let l = 0; l < lods; l++) {
    const bounds = intervalBoundaries(l, spacing0, cascadeCount);
    const reach = cascadeReach(l, spacing0, cascadeCount);
    const bands = [];
    for (let c = 0; c < cascadeCount; c++) {
      const t0 = c === 0 ? 0 : bounds[c - 1];
      const t1 = c === cascadeCount - 1 ? reach : bounds[c];
      bands.push({ cascade: c, t0, t1, len: intervalLength(c, l, spacing0), spacing: probeSpacing(c, l, spacing0) });
    }
    let gaps = 0;
    let overlaps = 0;
    for (let c = 1; c < bands.length; c++) {
      const d = bands[c].t0 - bands[c - 1].t1;
      if (d > 1e-6) gaps++;
      if (d < -1e-6) overlaps++;
    }
    if (bands[0].t0 > 1e-6) gaps++; // nobody owns [0, t_0)
    rows.push({ lod: l, reach, bands, gaps, overlaps });
  }
  return {
    rows,
    gaps: rows.reduce((a, r) => a + r.gaps, 0),
    overlaps: rows.reduce((a, r) => a + r.overlaps, 0),
    // The seam between LOD ladders — intended, and reported so a reader cannot
    // mistake the 10 % overlap for a cascade-level double count.
    lodSeam: rows.length > 1 ? rows[1].bands[0].t0 / (rows[0].reach || 1) : null,
  };
}

/** Which cascade owns distance `t` at this LOD — the CPU mirror of `splitCascade`. */
export function rcOwnerOf(t, spacing0, lod = 0, cascadeCount = CASCADE_COUNT) {
  const bounds = intervalBoundaries(lod, spacing0, cascadeCount);
  let k = 0;
  for (const b of bounds) if (t > b) k++;
  return Math.min(k, cascadeCount - 1);
}
