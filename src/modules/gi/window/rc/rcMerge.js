// §19 STAGE 5.2 — THE CONE MERGE, THE IRRADIANCE AND THE PIXEL, ALL PORTED
//
// ⭐⭐⭐ THERE IS NO NEW MATH IN THIS FILE. Eq. 7's eight-corner cone merge is
// `srcMerge.js`; the cosine-weighted irradiance tile (6 interior + 1 border
// octahedral texels, the layout `srcOctahedral`/`srcMath` mirror on both sides)
// is `srcTiles.js`; the eight-probe visibility-weighted pixel interpolation is
// `srcScreenGather.js`'s `gatherAt`. All three shipped, all three are gated by
// a CPU mirror in `srcRef.js`, and Stage 5 is a PORT. What this file writes is
// the WIRING — four calls and ONE kernel — and the kernel exists only because
// the destination changed.
//
// ══ THE ONE KERNEL, AND WHY IT IS THE WHOLE RESOLVE ═════════════════════════
//
// The old path owned its own screen texture (`giSrcGather`) and `giScreen`'s
// `createGiResolve` sampled it. GI2 does not work that way: `resolveHalf`
// writes `gi2IrradianceHalf` at half resolution and `resolveUpsample` — an
// edge-aware 2×2 magnify whose taps are rejected by plane distance and normal
// agreement — turns it into `gi2Irradiance`, the texture every material's
// `giIrradianceNode` binds, the `indirect` debug view shows and every
// `probe:gi2-*` reads.
//
// So the RC field does not need a resolve of its own. It needs to WRITE THE
// SAME HALF-RES TEXTURE, at the same texel, with the same alpha convention
// (`dot(N, P)`, the plane offset the upsample's edge test reads, with `-1e4`
// where there is no geometry). One kernel, spliced immediately after
// `resolveHalf`, and everything downstream — the upsample, the accumulator,
// GTAO's compose, the glossy slot, the lit-frame injection, the material hook —
// is untouched and cannot tell the difference except in the numbers.
//
// ⭐ AND THAT IS ALSO WHY THE GATE'S INSTRUMENTS NEED NO CHANGE. `probe:gi2-
// cornell` reads `gi2.textures.irradiance`; `probe:gi2-ref` reads it; the
// `indirect` view reads it. Writing one texture earlier in the same chain is
// the smallest possible surface for "the RC field is what the user sees".
//
// ══ WHAT RUNS, IN ORDER, AND WHY EACH BOUNDARY IS FORCED ════════════════════
//
//   [K'] hashBlock   the c0 key → bin-block tail, republished after compaction
//                    and before anything looks a key up. `srcSystem` moved this
//                    ABOVE the rays for [J]; here the only consumer is the
//                    gather, but the reason is the same — the hash slot layout
//                    is rebuilt every frame with scheduler-dependent contention,
//                    so a tail written last frame is misaligned with this
//                    frame's keys.
//   [G]  merge       AFTER `deposit.resolve` (it consumes the resolved payload
//                    and overwrites it in place) and BEFORE the bake.
//   [H]  tiles       AFTER the merge — baking raw resolved bins would bake the
//                    one-metre answer the merge exists to replace.
//   [I]  resolve     AFTER the bake. Reads LAST frame's atlas for nothing —
//                    the bake is in the same frame, above it.
//
// ══ THE STORAGE-BUFFER BUDGET, WHICH IS THE 5.1 CONSTRAINT ══════════════════
//
// 5.1's deposit kernel binds 8 of the portable 8. NOTHING HERE TOUCHES IT: the
// merge is its own dispatch (payload, cornerBlock, cornerWeight, stats,
// probeTable, hashKeys — 6), the bake is its own (payload, cosTable, stats,
// freeStack + the atlas as a storage TEXTURE — 4), and the resolve kernel binds
// exactly ONE storage buffer (`hashKeys`, keys + block tail, which is the whole
// point of `createSrcHashBlockFrame`) plus three textures. No kernel in this
// file is anywhere near the limit and no kernel in 5.1 gains a binding.
import {
  Fn, If, Return, float, instanceIndex, ivec2, max, sqrt, step, texture, textureStore, uint,
  uniform, vec3, vec4,
} from "three/tsl";
import { createSrcHashBlockFrame } from "../../srcProbes.js";
import { createSrcMergeFrame, formatSrcMerge } from "../../srcMerge.js";
import { createSrcTileAtlas, formatSrcTiles } from "../../srcTiles.js";
import { createSrcScreenGather } from "../../srcScreenGather.js";
import { MAX_LODS, W0 } from "../../srcConfig.js";

/**
 * Build [G] + [H] + [I] on a live RC cascade store.
 *
 * @param {object} o
 * @param {object} o.store        `createSrcProbeStore`'s, from `rcSystem`
 * @param {object} o.bins         `createSrcBinStore`'s, from `rcSystem`
 * @param {Node|number} o.spacing0
 * @param {Node} o.anchor  the SAME anchor uniform the population used. A merge
 *   or a gather placed from a second anchor reads plausible light from the
 *   wrong probes and no energy check can see it.
 * @param {Node} o.camera  world camera position (the LOD metric's centre).
 * @param {Node} o.sky     vec3 — the radiance the TOP cascade composites, and
 *   the residual `T·sky` the bake gives an orphan. Deposited nowhere else: the
 *   RC trace's miss returns the sky to `shadeHit`, but a miss lands past every
 *   cascade (`own = N`) so its radiance is never scattered — the deposit writes
 *   `(0, T=1)` and the sky enters ONCE, here.
 * @param {Node} o.frameStamp  the population's frame counter — §16 D3's probe
 *   maturity fade rides the block claim stamps against it.
 * @param {{position: object, normal: object}} o.gbuffer
 * @param {object} o.irradianceHalf  `gather.textures.
 *   irradianceHalf` — the texture `resolveUpsample` reads. THE destination.
 * @param {number} o.width  full-res gbuffer width/height (the half grid is
 *   `ceil(w/2)`, which is `gatherProbes`' own rule and must stay its rule).
 * @param {number} o.height
 * @param {number} [o.maxLods]
 * @param {Function} [o.losOccupied]  §15 U3b's one-bit occupancy closure. Null
 *   keeps the pre-U3b graph, which is the shipped default on both the merge and
 *   the gather (`__giMergeLosWeight` / `__giGatherLosWeight` are opt-in) and is
 *   what the corridor/doors gate is measured against.
 */
export function createRcMerge({
  store, bins, spacing0, anchor, camera, sky, frameStamp,
  gbuffer, irradianceHalf, width, height,
  maxLods = MAX_LODS, losOccupied = null, skyEnv = null,
  /**
   * ⭐⭐ §19 STAGE 5.3/5.3d — `rcDirect.createRcEmitterDirect`, the SEATED
   * emitter's direct term AND its filtered shadow. `null` builds not one node
   * of it.
   *
   * §19 5.3d — a BUNDLE now, not a bare closure: the visibility is traced and
   * cross-bilaterally filtered in three half-res passes of its own (see
   * `rcDirect.js` for why the filter is the whole difference between 5.3's
   * blotchy 0.365 arm and the old path's picture), and `directAt` takes the
   * half-res texel so it can read them.
   *
   * The field cannot carry a seated lamp: `#gi2SlotEmissive` zeroes a promoted
   * emitter's palette emission, so a ray that hits it reads nothing, which is
   * the ONE-REPRESENTATION rule working exactly as intended. Both shipped paths
   * therefore add the NEE term at the PROBE (`emitterDirectPass`,
   * `worldProbes.neePass`) and the cascades had it NOWHERE — see the closure's
   * own header for the measurement.
   *
   * ⚠ NO DOUBLE COUNT, AND THE ARGUMENT IS THE ZERO: the merged field's
   * contribution at this pixel is what RAYS brought back, and a ray that lands
   * on the lamp brings back `ρ/π·(sun + NEE) + palEm` with `palEm = 0`. The
   * lamp's own emission enters the picture through this term and through no
   * other. The SECOND bounce of the same lamp is a different term entirely —
   * it is `Enee` inside the face cache at whatever surface the lamp lit, which
   * the field does carry, and which this add does not touch.
   */
  direct = null,
}) {
  const halfW = Math.max(1, Math.ceil(width / 2));
  const halfH = Math.max(1, Math.ceil(height / 2));

  // ── [K'] the c0 key → block tail ──────────────────────────────────────────
  const hashBlock = createSrcHashBlockFrame(store, 0);

  // ── [G] the merge ─────────────────────────────────────────────────────────
  const merge = createSrcMergeFrame(store, bins, {
    spacing0, anchor, camera, sky, skyEnv, w0: W0, losOccupied,
  });

  // ── [H] the c0 irradiance tiles ───────────────────────────────────────────
  //
  // c0 ONLY, and `srcTiles`' own header carries the argument: a merged c0 bin
  // already holds the whole chain's answer at the finest spacing the hierarchy
  // has, so tiles for c1-c3 would bake the same light more coarsely and nothing
  // would read them.
  const tiles = createSrcTileAtlas(store, bins, { w0: W0, sky, frameStamp, skyEnv });

  // ── [I] the eight-probe interpolation, as a CLOSURE ───────────────────────
  //
  // `readPixel` omitted on purpose: that builds `gatherAt` and nothing else —
  // no storage texture, no dispatch, no `__giSrcTargetVersion` bump. The screen
  // pass below is ours because the DESTINATION is GI2's, and this is exactly
  // the seam `srcScreenGather`'s own header opened for `srcSecondary`.
  const gather = createSrcScreenGather(store, tiles, {
    lookup: hashBlock.lookup, spacing0, camera, anchor, maxLods, w0: W0,
  });

  // ── the one kernel ────────────────────────────────────────────────────────
  const posN = texture(gbuffer.position);
  const nrmN = texture(gbuffer.normal);
  const widthU = uniform(width, "uint");
  const heightU = uniform(height, "uint");
  const halfWU = uniform(halfW, "uint");
  const halfHU = uniform(halfH, "uint");
  /**
   * Live, and 1 by default — the A/B arm that makes "is the picture the RC
   * field or the world probes'" a within-boot dial instead of two boots. 0
   * leaves `resolveHalf`'s own write standing and this kernel becomes a read
   * with no store, which is the control the at-rest Δ needs.
   */
  const writeU = uniform(1);

  const resolvePass = Fn(() => {
    const i = instanceIndex.toVar();
    const gx = i.mod(halfWU).toVar();
    const gy = i.div(halfWU).toVar();
    If(gy.greaterThanEqual(halfHU).or(writeU.lessThan(0.5)), () => { Return(); });
    // ⭐ THE HALF-RES THREAD OWNS THE TOP-LEFT PIXEL OF ITS 2×2 QUAD, and reads
    // the gbuffer THERE — `gatherProbes`' `makeResolve(half)` maps exactly this
    // way and `resolveUpsample` maps BACK the same way, so the surface a
    // low-res sample was computed on is the surface the upsample tests against.
    // A filtered centre here would make every edge test compare two different
    // surfaces and the halo it produces would live on every silhouette.
    const px = gx.mul(uint(2)).min(widthU.sub(uint(1))).toVar();
    const py = gy.mul(uint(2)).min(heightU.sub(uint(1))).toVar();
    const t = ivec2(px.toInt(), py.toInt());
    const g = posN.load(t).toVar();
    const nrm = nrmN.load(t).xyz.toVar();
    const E = vec3(0).toVar();
    /**
     * ⚠ THE ALPHA IS THE UPSAMPLE'S EDGE TEST, NOT A VALIDITY BIT. It carries
     * `dot(N, P)` — the sample's plane offset — and `-1e4` where there is no
     * geometry, which is `resolveHalf`'s convention verbatim. Writing anything
     * else here does not make the picture wrong in a way anyone would see; it
     * makes every silhouette's 2×2 taps mutually acceptable, which is a halo.
     */
    const a = float(-1e4).toVar();
    If(g.w.greaterThan(0.5), () => {
      // `normalize` on a zero normal is NaN and a NaN alpha poisons four
      // full-res pixels, so the length is floored rather than assumed. (The
      // engine's own resolve normalizes unguarded; this is a strict
      // improvement that differs only where that one produced NaN.)
      const len2 = nrm.dot(nrm).toVar();
      const Nn = nrm.div(sqrt(max(len2, float(1e-12)))).toVar();
      a.assign(Nn.dot(g.xyz));
      // ⭐ THE GATHER TAKES THE CAMERA-FACED NORMAL, THE ALPHA DOES NOT.
      //
      // Two different jobs. The deposit filled these probes' bins along the
      // FACED normal (`rcSystem`'s `readPixel` — a double-sided wall seen from
      // inside a room has its normal pointing out, and a hemisphere around it
      // samples the outside), so the hemisphere the gather reads must be the
      // hemisphere that was filled. The upsample's plane test compares against
      // the RAW normal `resolveUpsample` re-reads at full res, so the alpha
      // must be the raw one or every tap is rejected on the flipped surfaces.
      If(len2.greaterThan(0.25), () => {
        const facing = step(0, Nn.dot(vec3(camera).sub(g.xyz))).mul(2).sub(1).toVar();
        const Nf = Nn.mul(facing).toVar();
        E.assign(gather.gatherAt(g.xyz, Nf).irradiance);
        // §19 5.3/5.3d — the seated emitters, analytically, at the shading
        // point, times this texel's FILTERED visibility. Against the FACED
        // normal, like the gather: the hemisphere a lamp lights is the
        // hemisphere the field was filled over.
        if (direct) E.addAssign(direct.directAt(g.xyz, Nf, gx, gy));
      });
    });
    textureStore(irradianceHalf, ivec2(gx.toInt(), gy.toInt()), vec4(E, a));
  })().compute(halfW * halfH);

  return {
    hashPass: hashBlock.pass,
    /** §19 5.3 — [J] resolves probe corners at every hit through the same
     * single-buffer key → block closure this file's screen kernel uses. */
    hashBlock,
    merge,
    tiles,
    gather,
    resolvePass,
    /**
     * [G] → [H] → [I]. `hashPass` is NOT here: it belongs above the rays.
     *
     * §19 5.3d — the emitter shadow's three passes sit immediately before the
     * pixel resolve that reads them. They depend on the gbuffer and the window
     * bits alone, so their position is free; putting them adjacent to their one
     * consumer is what keeps "the visibility this pixel multiplies is the
     * visibility computed for this pixel this frame" readable at the call site.
     */
    passes: [...merge.passes, ...tiles.passes, ...(direct?.passes ?? []), resolvePass],
    uniforms: {
      rcResolveWrite: writeU, rcResolveWidth: widthU, rcResolveHeight: heightU,
      ...(direct?.uniforms ?? {}),
    },
    direct,
    halfW, halfH,
    setSize(w, h) {
      const nw = Math.max(1, Math.round(w));
      const nh = Math.max(1, Math.round(h));
      if (Math.ceil(nw / 2) * Math.ceil(nh / 2) > halfW * halfH) return false;
      widthU.value = nw;
      heightU.value = nh;
      halfWU.value = Math.max(1, Math.ceil(nw / 2));
      halfHU.value = Math.max(1, Math.ceil(nh / 2));
      if (direct && !direct.setSize(nw, nh)) return false;
      return true;
    },
    bytes: (merge.bytes ?? 0) + (tiles.bytes ?? 0),
    storageAttributes: () => [
      ...(merge.storageAttributes ?? []),
      ...(tiles.storageAttributes ?? []),
      ...(gather.storageAttributes ?? []),
    ].filter(Boolean),
    async readStats(renderer) {
      const [m, t] = await Promise.all([
        merge.readStats(renderer).catch(() => null),
        tiles.readStats(renderer).catch(() => null),
      ]);
      return { merge: m, tiles: t, line: [formatSrcMerge(m), formatSrcTiles(t)].filter(Boolean).join(" — ") };
    },
    dispose() {
      merge.dispose?.();
      tiles.atlas?.dispose?.();
      gather.dispose?.();
      direct?.dispose?.();
    },
  };
}
