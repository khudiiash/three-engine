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
import {
  If, bitAnd, bitXor, dot, float, mix, select, shiftLeft, shiftRight, sqrt, uint, vec3,
} from "three/tsl";
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
 * @param {Function} [o.gatherAt]  §19 5.3b — the merged field's eight-probe
 *   resolve. Present ⇒ [J] adds `ρ·E_rc/π` out of the cache's SECONDARY region;
 *   absent ⇒ [J] is direct-only and the caller must supply the bounce itself.
 * @param {number} [o.ercAlpha]  blend toward the new gather on a refresh. 1 (the
 *   shipped value) makes the write order-free; see `shade`.
 * @param {object} [o.ercPhase]  a uint node — the frame stamp the budget's phase
 *   test compares a face's address against.
 * @param {object} [o.ercPeriodMask]  a uint node, `period − 1` (a power-of-two
 *   mask). Absent ⇒ every hit face refreshes every frame.
 * @param {boolean} [o.compact]  drop `P`/`N` from the record (§19 5.3b) — and
 *   `Le` too unless the gather published `hitEmissionRay` (§19 5.3c).
 */
export function createRcHitShading({
  cache, kit, counters = null, gatherAt = null,
  ercAlpha = 1, ercPhase = null, ercPeriodMask = null, compact = true,
}) {
  const { u, dominantFace, faceSamplePoint, shadeHit, hitPalette, hitEmissionRay } = kit;
  /**
   * ⭐⭐⭐ §19 STAGE 5.3c — THE EMISSION IS A PROPERTY OF THE RAY NOW, SO IT
   * TRAVELS IN THE RECORD.
   *
   * `hitEmissionRay` is `L_e · cov · |d·n_dom| / (|dx|+|dy|+|dz|)` — a
   * DIRECTIONAL quantity (see `gatherProbes`' `RC5_EMIT_PROJ`). The face cache
   * holds ONE radiance for all directions, so a directional term cannot be
   * stored there; it is computed in [E], where `dir` is known, written into
   * `SEC_LE` and added in [J]. The six `P`/`N` words 5.3b dropped stay dropped
   * — those really are functions of the address; this one is not.
   *
   * Absent (the isotropic arm, the world path, any pre-5.3c build) not one node
   * of it is constructed and the record stays nine words lighter.
   */
  const rayEmission = typeof hitEmissionRay === "function" ? hitEmissionRay : null;
  const writesLe = !compact || !!rayEmission;
  if (typeof hitPalette !== "function") {
    throw new Error(
      "createRcHitShading: the gather must publish `hitPalette` — [J] multiplies the cascade " +
      "field by the hit's ρ and adds it to a cache word `shadeHit` wrote, and two transcriptions " +
      "of that albedo are two chances for the halves to disagree about which surface they are on",
    );
  }
  if (gatherAt && !(cache.ercRead && cache.ercWrite)) {
    throw new Error(
      "createRcHitShading: the radiance cache was built without `erc` — §19 5.3b caches E_rc PER " +
      "FACE in a second region of the cache's own buffer, and without it [J] is back to a gather " +
      "per ray (5.3 measured that at 3.03 ms of a 9.58 ms ultra chain)",
    );
  }

  /**
   * [E]'s half: what a hit IS, with no light in it at all.
   *
   * Runs for every ray, hit or miss, exactly as the inline shader did — a miss
   * leaves `slot` EMPTY in `srcDeposit` and falls out of the append with no
   * test of its own.
   *
   * ⭐⭐ §19 STAGE 5.3b — `compact` DROPS **P**, **N** AND **Le** FROM THE
   * RECORD, AND IT IS A DEPOSIT SAVING, NOT A TIDY-UP. All three are FUNCTIONS
   * OF `addr`, which the record carries anyway: the face's normal IS
   * `normalOfFace(face)` and its shade point IS `faceSamplePoint(level, voxel,
   * n)` — the two expressions this closure filled them with — while `Le` was
   * never read by anyone, because a face's emission reaches [J] inside the CACHE
   * WORD `shadeHit` wrote, which is where the one-representation rule puts it.
   * Nine `atomicStore`s per hit, on the pass that runs for every ray in the
   * frame, to carry values the reader recomputes from a word it already loads.
   *
   * ⚠ THE RECORD'S STRIDE IS UNCHANGED. `SECONDARY_HIT_WORDS` is still 16 and
   * the shipped path's layout with it — only these writes, and the matching
   * reads in [J], are gone. A stride change would have been a second meaning for
   * the same buffer and a silent misread the first time a gate ran the old path.
   */
  const attribute = (r, dir) => {
    const zi = r.raw.z.toUint().toVar();
    const P = compact ? null : vec3(0).toVar();
    const N = compact ? null : vec3(0).toVar();
    const rho = vec3(0).toVar();
    const Le = writesLe ? vec3(0).toVar() : null;
    const addr = uint(0).toVar();
    // §AG's coverage, carried through ρ — see the header. Held as its own word
    // too, because [J]'s direct half needs it and ρ is already spoken for.
    const T = float(r.throughput).toVar();
    If(r.raw.x.greaterThan(0.5), () => {
      const entryF = bitAnd(zi, uint(7)).toFloat().toVar();
      const levelF = bitAnd(shiftRight(zi, uint(3)), uint(7)).toFloat().toVar();
      const voxF = shiftRight(zi, uint(6)).toFloat().toVar();
      const faceF = dominantFace(levelF, voxF, entryF, dir.negate()).toVar();
      // `wantEmissive` false on the compact build: the emission the record used
      // to carry costs a coverage read and six occupancy bits under §19 5.3b's
      // energy conservation, once per RAY, for a word nobody reads.
      const pal = hitPalette(levelF, voxF, !compact && !rayEmission);
      rho.assign(pal.rho.mul(T));
      // §19 5.3c — the ray's own share of this voxel's authored power. Inside
      // the hit branch, so a miss pays nothing; `dir` is the ray's direction and
      // `faceF` the voxel's DOMINANT face, which is the pair the projected-area
      // law is written in.
      if (rayEmission) Le.assign(rayEmission(levelF, voxF, faceF, dir));
      if (!compact) {
        const hn = normalOfFace(faceF).toVar();
        N.assign(hn);
        // ⭐ THE SHADE POINT BELONGS TO THE SLOT, NOT TO THE RAY (§19 3.9): the
        // voxel's face plane, so every ray reaching this face shades the same
        // point and re-shading is idempotent.
        P.assign(faceSamplePoint(levelF, voxF, hn));
        if (!rayEmission) Le.assign(pal.Le);
      }
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
   * [J]'s half: BOTH terms of the hit's radiance, out of TWO WORDS OF ONE
   * BUFFER at ONE address.
   *
   * ⚠ THE CACHE STORES THE FACE'S OWN RADIANCE, NOT THE RAY'S. The accumulate
   * takes the unattenuated shade `s`; only the value handed back to the deposit
   * is multiplied by this ray's coverage. Getting that backwards would write a
   * cable's shadow into a wall's memory of the sun.
   *
   * ⭐ AND THE DIRECT SHADE IS `Le + ρ/π · (sun + NEE)` — a FIXED function of
   * the face with no stochastic input anywhere in it, which is what makes the
   * cadence a latency knob instead of a noise source.
   *
   * ══ ⭐⭐⭐ §19 STAGE 5.3b — `E_rc` IS A PROPERTY OF THE FACE, SO IT IS PAID
   *    ONCE PER FACE ══════════════════════════════════════════════════════════
   *
   * 5.3 called `gatherAt` once per HIT — a hash lookup, eight probe corners and
   * a tile-atlas read each — for a number that cannot depend on the ray:
   * `faceSamplePoint` pins the query point to the voxel's face plane and
   * `normalOfFace` pins the normal to the face, so every ray landing on a face
   * asks the merged field the identical question. Measured on the 5.1 gate at
   * ultra that was **3.03 ms of a 9.58 ms chain** spent recomputing one value
   * 600 000 times.
   *
   * So `E_rc` becomes a CACHED PER-FACE WORD in the cache's secondary region,
   * refreshed on a budget, and the deposit reads
   *
   *     L(H) = direct_face(H)·T  +  ρ · E_rc(H) / π
   *
   * with ONE address and TWO loads. It needs no append list of its own: the
   * refresh queue IS the hit list the deposit already writes, which is exactly
   * "the faces hit this frame" and is therefore free.
   *
   * ⚠ THE REFRESH IS ORDER-FREE, WHICH IS WHY IT NEEDS NO QUEUE AND NO SORT.
   * Every ray reaching a face in one frame computes `gatherAt(faceP, faceN)`
   * from the same point, the same normal and the same merged field, so they all
   * write the SAME value — which of them lands last cannot change the word, and
   * §T holds without the pass enumerating faces in a fixed order. `ercAlpha = 1`
   * keeps that true exactly; a smaller α would make the result depend on how
   * many rays happened to hit the face, which is why the shipped value is 1 and
   * why the temporal smoothing this could have bought is left to the cascade
   * bins, where `TEMPORAL_ALPHA` already lives.
   *
   * ⚠ AND `E_rc` IS THE FIELD, NEVER THE FACE'S OWN LIGHT. `shadeHit` under
   * `rc5` is direct-only and `injectLitFrame` is not built, so this term comes
   * exclusively from the merged cascades: the loop is probes → hits → probes,
   * whose gain is the albedo, and never cache → cache, whose gain was 1/(1−ρ)
   * at the user's ρ = 1.0 walls.
   */
  /**
   * ⭐⭐⭐ §19 STAGE 5.4d — THE BOUNCE CAP: THE ONE ARM THAT SEPARATES THE LOOP
   * FROM THE TRANSPORT.
   *
   * The shipped chain is a fixed-point iteration — probes → faces → hits →
   * deposit → merge → tile → probes — and a gain measured on its converged
   * answer cannot say WHICH hop loses energy, because every hop is inside the
   * loop. `__gi2Rc5BounceCap = 1` cuts the return edge: a hit brings back its
   * DIRECT face radiance and nothing else, so the field is exactly
   *
   *     analytic direct at the pixel  +  ONE bounce through the transport
   *
   * which is precisely `makeSceneTracer`'s `BOUNCES = 1` (`Lo` at depth 0 is
   * NEE at the hit and a cosine ray that returns 0). Two quantities defined the
   * same way, on the same pixels: the ratio is the TRANSPORT's gain with the
   * loop removed. ≈1 ⇒ the transport is exact and the loss is the E_rc hop;
   * <1 ⇒ one bounce is already short and the loop only compounds it.
   *
   * ⚠ AN INSTRUMENT, NOT A QUALITY KNOB. It removes the second bounce and every
   * bounce after it, so the picture under it is wrong by construction.
   */
  const bounceCap = (globalThis.__gi2Rc5BounceCap ?? 0) !== 0;

  const shade = (P0, n0, rho, Le, T, addr) => {
    const a = uint(addr).toVar();
    const { faceF, levelF, voxF } = unpackAddr(a);
    const fF = faceF.toVar();
    const lF = levelF.toVar();
    const vF = voxF.toVar();
    // The face's own geometry, recovered from the address instead of carried
    // through six words of the record — see `attribute`'s `compact` note. Both
    // expressions are [E]'s, verbatim, so the shade point is the same point.
    const hn = normalOfFace(fF).toVar();
    const hp = faceSamplePoint(lF, vF, hn).toVar();

    // ── the DIRECT half ────────────────────────────────────────────────────
    const L = vec3(0).toVar();
    const c = cache.cacheRead(lF, vF, fF).toVar();
    counters?.shaded(1);
    L.assign(c.xyz);
    If(c.w.lessThan(0.5), () => {
      // `seedU` is `uint(1)` and is dropped by `shadeHit` under `rc5` — see the
      // header. `.toVar()` on the accumulate is load-bearing: a call for side
      // effect alone is dead-code-eliminated.
      const s = shadeHit(hp, hn, lF, vF, uint(1)).toVar();
      cache.cacheAccum(lF, vF, fF, s, u.nCapU, u.cacheSmoothU).toVar();
      L.assign(s);
    });

    // ── the SECONDARY half: the merged field at this face, on a budget ──────
    let Lb = null;
    if (gatherAt && !bounceCap) {
      const e = cache.ercRead(lF, vF, fF).toVar();
      const fresh = e.w.lessThan(0.5).toVar();
      const E = e.xyz.toVar();
      // THE BUDGET, AS A PHASE TEST ON THE ADDRESS — no counter, no queue, no
      // per-face age word. A face refreshes on the frame whose stamp matches its
      // own low bits, so the cost is 1/period of the hits and the refreshed SET
      // rotates deterministically over the whole cache. A never-gathered face
      // jumps the queue: "no data" must not be read as "no light" for a whole
      // period, which is the same rule the direct word's zero sentinel follows.
      // ⭐⭐⭐ §19 STAGE 5.3c — THE PHASE IS A HASH OF THE ADDRESS, AND THAT IS
      // A CORRECTNESS FIX RATHER THAN A BETTER SPREAD.
      //
      // `packAddr` puts the FACE in bits 0-2 and the level in 3-5, so 5.3b's
      // `addr & (period−1)` was the FACE INDEX MOD 4 and nothing else. The set
      // that refreshed on a frame was therefore not "one quarter of the cache"
      // — it was ONE FACE ORIENTATION OF THE WHOLE SCENE: every +Y face in the
      // world (the entire floor) on one frame, every −Y face (the entire
      // ceiling) on the next, and faces 4/5 ALIASED onto phases 0/1, refreshing
      // twice as often as 2/3. A whole surface stepping as one rigid block,
      // four frames apart, inside a bounce loop whose gain on the user's ρ = 1.0
      // walls is ≈ 1: a coloured Gauss-Seidel sweep with an aliased colouring,
      // and 5.3b's at-rest Δ regression (p90 1.47 % → 3.9-9.6 %) is its
      // amplitude.
      //
      // A multiplicative hash makes the phase a uniform 1/period sample of the
      // ADDRESS SPACE, so neighbouring voxels and the six faces of one voxel
      // land in different phases: every surface has ~1/period of its faces
      // refreshed on every frame, the loop sees a spatial average instead of a
      // coherent step, and every address refreshes at exactly the same rate.
      const mixed = a.mul(uint(2654435761)).toVar();
      const phaseOfAddr = bitXor(mixed, shiftRight(mixed, uint(16))).toVar();
      const due = ercPeriodMask
        ? fresh.or(bitAnd(phaseOfAddr, ercPeriodMask).equal(bitAnd(ercPhase, ercPeriodMask)))
        : fresh;
      If(due, () => {
        const g = vec3(gatherAt(hp, hn).irradiance).toVar();
        cache.ercWrite(lF, vF, fF, g, ercAlpha).toVar();
        E.assign(select(fresh, g, mix(e.xyz, g, float(ercAlpha))));
      });
      // ρ ALREADY CARRIES `T` (`attribute` folds the coverage into it), so this
      // half is attenuated exactly once and by the same number as the other.
      Lb = rho.mul(E).mul(1 / Math.PI).toVar();
    }
    // §19 5.3c — the emission the RECORD carries, added to the direct word the
    // CACHE carries. `L.mul(T)` below attenuates both by this ray's coverage,
    // which is the same `T` `rho` already carries — one number, both halves.
    if (rayEmission) L.addAssign(vec3(Le));
    return { L: L.mul(T), Lb };
  };

  /**
   * §19 5.3c — which record words this build actually writes, published so the
   * deposit's `hitFields` and [J]'s reads cannot disagree about the layout. A
   * mismatch is not an error anywhere: it is `uintBitsToFloat` of a stale word.
   */
  const hitFields = { P: !compact, N: !compact, Le: writesLe };

  return { attribute, shade, hitFields };
}

// ⭐ §19 STAGE 5.3d — `createRcDirectAt` LIVED HERE AND HAS MOVED TO
// `rcDirect.js`, WHOLE. 5.3's version traced ONE BINARY SHADOW RAY PER PIXEL
// and showed it to the user; the measurement that put it behind a hatch (gain
// 0.365, blotch σ 45 → 95 %) was measuring the missing FILTER, not the missing
// term — the engine's own emitter chain traced per pixel too and ran the result
// through a bilateral and two wide passes before any material sampled it. The
// replacement is that shape on the window's trace, and it keeps the solid-angle
// expression byte-for-byte so one lamp still delivers one energy on every path.
// There is deliberately no copy of it left in this file: two transcriptions of
// `Ω = min(π, π·r_eff²/d²)` are two chances for the paths to disagree.
